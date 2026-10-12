// Firestore answer for api() when the VITE_FIREBASE=1 build runs without api/server.js.
// Every call through api() is served here from the user's Firestore document, so the rest of
// the app stays unchanged and the flag is the only fork between the two backends.
import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged } from 'firebase/auth'
import { getFirestore, doc, getDoc, runTransaction, serverTimestamp, Bytes } from 'firebase/firestore'
import { FIREBASE_CONFIG } from './firebase-config.js'
import { stampPut } from '../../../api/sync-stamps.js'

// How many earlier write ids a document keeps, mirroring WID_KEEP in api/server.js
const WID_KEEP = 50
// A Firestore document caps at 1 MiB; rejects below it so the field overhead still fits
const MAX_Z = 900000

let auth = null
let db = null
// Created on first use so the SDK only loads in the Firebase build: api.js imports this
// module solely when FIREBASE is set, via a dynamic import
function backend() {
  if (!db) {
    const app = initializeApp(FIREBASE_CONFIG)
    auth = getAuth(app)
    db = getFirestore(app)
  }
  return { auth, db }
}

const toUser = u => ({ id: u.uid, name: u.displayName || u.email, admin: false })

// Same shape exchange() in api.js throws: the message, the HTTP status and the parsed body
const failure = (status, data) => Object.assign(new Error((data && data.error) || ('HTTP ' + status)), { status, data: data || {} })
// A stored document as a client gets it: without the server's own notes, like forClient() there
function forClient(S) {
  if (!S || typeof S !== 'object' || !('_unstamped' in S || '_prior' in S)) return S
  const { _unstamped, _prior, ...rest } = S
  return rest
}

let seenAuth = null
export function waitForAuth() {
  const { auth: a } = backend()
  if (!seenAuth) seenAuth = new Promise(resolve => { try { onAuthStateChanged(a, () => resolve()) } catch { resolve() } })
  return seenAuth
}

export async function firebaseSignIn() {
  const { auth: a } = backend()
  const provider = new GoogleAuthProvider()
  try {
    const res = await signInWithPopup(a, provider)
    return toUser(res.user)
  } catch (e) {
    // A blocked popup leaves no other way in on this page: the redirect signs in and reloads,
    // so there is no user to hand back yet and the caller waits for the reload instead
    if (e && typeof e.code === 'string' && e.code.includes('popup')) {
      await signInWithRedirect(a, provider)
      return a.currentUser ? toUser(a.currentUser) : null
    }
    throw e
  }
}

export async function firebaseSignOut() {
  await signOut(backend().auth)
}

async function readAll(stream) {
  const parts = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const flat = new Uint8Array(parts.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of parts) {
    flat.set(c, at)
    at += c.length
  }
  return flat
}

async function squeeze(state) {
  const cs = new CompressionStream('gzip')
  // The reader drains the queue while writing: a document larger than the stream's buffer
  // would otherwise hold write() back until someone reads, which nobody does yet
  const done = readAll(cs.readable)
  const writer = cs.writable.getWriter()
  await writer.write(new TextEncoder().encode(JSON.stringify(state)))
  await writer.close()
  return done
}

async function spread(u8) {
  const ds = new DecompressionStream('gzip')
  const done = readAll(ds.readable)
  const writer = ds.writable.getWriter()
  await writer.write(u8)
  await writer.close()
  return JSON.parse(new TextDecoder().decode(await done))
}

const bytesOf = z => {
  if (!z) return null
  if (z instanceof Uint8Array) return z
  if (typeof z.toUint8Array === 'function') return z.toUint8Array()
  return null
}

const refs = uid => {
  const { db: d } = backend()
  return {
    main: doc(d, 'apps', 'opengym', 'users', uid, 'state', 'main'),
    meta: doc(d, 'apps', 'opengym', 'users', uid, 'state', 'meta'),
  }
}

async function requireUid() {
  await waitForAuth()
  const u = backend().auth.currentUser
  if (!u) throw failure(401, { error: 'not signed in' })
  return u.uid
}

// Entries the server's readers walk (`w.d`, `r.id`): what is not an entry is dropped on the
// way in rather than refused, exactly like `records` in api/server.js
const isList = v => v == null || Array.isArray(v)
const record = x => !!x && typeof x === 'object' && !Array.isArray(x)

async function putData(body) {
  const uid = await requireUid()
  const sent = body && body.state
  if (!sent || typeof sent !== 'object') throw failure(400, { error: 'state required' })
  if (!Array.isArray(sent) && !Object.keys(sent).some(k => k !== '_rev' && k !== '_ts')) throw failure(400, { error: 'state required' })
  if (Array.isArray(sent) || !isList(sent.workouts) || !isList(sent.routines)) throw failure(400, { error: 'invalid state' })
  for (const k of ['workouts', 'routines']) if (Array.isArray(sent[k])) sent[k] = sent[k].filter(record)
  const { main, meta } = refs(uid)
  return runTransaction(backend().db, async tx => {
    // Firestore reruns this function on contention: each attempt starts from what was sent,
    // not from the copy the previous attempt stamped
    const next = structuredClone(sent)
    const snap = await tx.get(main)
    const raw = snap.exists() ? snap.data() : null
    const z0 = raw ? bytesOf(raw.z) : null
    const cur = z0 ? await spread(z0) : null
    const curRev = (cur && cur._rev) || 0
    if ((body.baseRev != null && body.baseRev !== curRev) ||
        (body.baseRev != null && typeof body.baseWid === 'string' && cur && cur._wid && body.baseWid !== cur._wid)) {
      throw failure(409, { error: 'conflict', rev: curRev, state: forClient(cur) })
    }
    delete next.active
    // A reset stamp only moves forward: a write without it keeps the stored one, like the server
    const storedReset = Number((cur && cur.resetAt) || 0)
    if (storedReset > (Number(next.resetAt) || 0)) {
      next.resetAt = cur.resetAt
      if (cur.resetIds && typeof cur.resetIds === 'object') next.resetIds = cur.resetIds
      else delete next.resetIds
    }
    const report = {}
    try {
      stampPut(cur, next, { overRead: body.baseRev != null && body.baseRev === curRev, stamped: body.stamped === true, report })
    } catch (e) {
      if (e instanceof RangeError) throw failure(400, { error: 'invalid state' })
      throw e
    }
    next._rev = curRev + 1
    if (report.changed) next._rev = curRev + 2
    next._wids = [...(cur && Array.isArray(cur._wids) ? cur._wids : []), ...(cur && cur._wid ? [cur._wid] : [])]
      .filter(x => typeof x === 'string').slice(-WID_KEEP)
    const rnd = crypto.getRandomValues(new Uint8Array(8))
    next._wid = [...rnd].map(x => x.toString(16).padStart(2, '0')).join('')
    let z1
    try {
      z1 = await squeeze(next)
    } catch (e) {
      if (e instanceof RangeError) throw failure(400, { error: 'invalid state' })
      throw e
    }
    if (z1.length > MAX_Z) throw failure(413, { error: 'state too large' })
    tx.set(main, { rev: next._rev, wid: next._wid, z: Bytes.fromUint8Array(z1) })
    tx.set(meta, { rev: next._rev, wid: next._wid, size: z1.length, updatedAt: serverTimestamp() })
    return { ok: true, ts: next._ts || null, rev: curRev + 1, wid: next._wid }
  })
}

async function route(path, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase()
  let body
  if (opts && opts.body != null) {
    try { body = JSON.parse(opts.body) } catch { body = {} }
  }
  const key = method + ' ' + path
  if (key === 'GET /api/health') return { ok: true }
  if (key === 'GET /api/config') {
    const out = { invite_only: false, allow_guest: true }
    if (backend().auth.currentUser) out.coach = null
    return out
  }
  if (key === 'GET /api/me') {
    await waitForAuth()
    const u = backend().auth.currentUser
    if (!u) throw failure(401, { error: 'not signed in' })
    return { user: toUser(u) }
  }
  if (key === 'POST /api/logout' || key === 'POST /api/logout/all') {
    await firebaseSignOut()
    return { ok: true }
  }
  if (key === 'GET /api/data/rev') {
    const { meta } = refs(await requireUid())
    const snap = await getDoc(meta)
    const m = snap.exists() ? snap.data() : null
    return { rev: (m && m.rev) || 0, ...((m && m.wid) ? { wid: m.wid } : {}) }
  }
  if (key === 'GET /api/data') {
    const { main } = refs(await requireUid())
    const snap = await getDoc(main)
    if (!snap.exists()) return { state: null, rev: 0 }
    const raw = snap.data() || {}
    const z = bytesOf(raw.z)
    if (!z) return { state: null, rev: 0 }
    const state = forClient(await spread(z))
    return { state, rev: raw.rev || state._rev || 0 }
  }
  if (key === 'PUT /api/data') return putData(body)
  // Push, media, coach, admin and activity stay server-only: the app reads 404 as feature absent
  throw failure(404, { error: 'not available' })
}

export async function shimApi(path, opts = {}) {
  try {
    return await route(String(path || '').split('?')[0], opts)
  } catch (e) {
    // Firestore's "the backend is unreachable" reads as offline, like api()'s timeout: the
    // store shows the device as offline instead of an error
    if (e && e.code === 'unavailable') throw Object.assign(new Error('offline'), { code: 'timeout' })
    throw e
  }
}
