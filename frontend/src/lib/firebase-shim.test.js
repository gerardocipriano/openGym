// The Firebase shim answers api() from Firestore instead of api/server.js: the SDK is
// mocked here with an in-memory document store, while the real gzip path still runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => {
  const s = { user: null, store: new Map() }
  s.auth = { get currentUser() { return s.user } }
  return s
})

vi.mock('firebase/app', () => ({ initializeApp: () => ({}) }))
vi.mock('firebase/auth', () => ({
  getAuth: () => m.auth,
  GoogleAuthProvider: class {},
  signInWithPopup: async () => ({ user: m.user }),
  signInWithRedirect: async () => {},
  signOut: async () => { m.user = null },
  onAuthStateChanged: (auth, cb) => { cb(m.user); return () => {} },
}))
vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  doc: (...args) => ({ _path: args.slice(1).join('/') }),
  getDoc: async ref => ({ exists: () => m.store.has(ref._path), data: () => m.store.get(ref._path) }),
  runTransaction: async (db, fn) => fn({
    get: async ref => ({ exists: () => m.store.has(ref._path), data: () => m.store.get(ref._path) }),
    set: (ref, data) => { m.store.set(ref._path, data) },
  }),
  serverTimestamp: () => ({ _server: true }),
  Bytes: { fromUint8Array: u8 => ({ _u8: u8, toUint8Array: () => u8 }) },
}))

import { shimApi } from './firebase-shim.js'

const signIn = (uid = 'u1') => { m.user = { uid, displayName: 'Test User', email: 'test@example.com' } }
const put = state => shimApi('/api/data', { method: 'PUT', body: JSON.stringify({ state }) })

beforeEach(() => { m.user = null; m.store.clear() })

describe('firebase-shim', () => {
  it('answers 401 when signed out', async () => {
    await expect(shimApi('/api/data')).rejects.toMatchObject({ status: 401, data: { error: 'not signed in' } })
    await expect(shimApi('/api/data/rev')).rejects.toMatchObject({ status: 401 })
    await expect(shimApi('/api/me')).rejects.toMatchObject({ status: 401 })
  })

  it('answers an empty profile before the first write', async () => {
    signIn()
    await expect(shimApi('/api/data')).resolves.toEqual({ state: null, rev: 0 })
    await expect(shimApi('/api/data/rev')).resolves.toEqual({ rev: 0 })
    await expect(shimApi('/api/health')).resolves.toEqual({ ok: true })
  })

  it('round-trips a document through PUT and GET', async () => {
    signIn()
    const wrote = await put({ unit: 'kg', workouts: [], routines: [] })
    expect(wrote.ok).toBe(true)
    expect(wrote.rev).toBe(1)
    expect(typeof wrote.wid).toBe('string')
    const got = await shimApi('/api/data')
    expect(got.rev).toBe(1)
    expect(got.state.unit).toBe('kg')
    expect(got.state._rev).toBe(1)
    await expect(shimApi('/api/data/rev')).resolves.toEqual({ rev: 1, wid: wrote.wid })
  })

  it('refuses a write over a revision it did not read, with the document attached', async () => {
    signIn()
    await put({ unit: 'kg', workouts: [], routines: [] })
    const err = await shimApi('/api/data', { method: 'PUT', body: JSON.stringify({ state: { unit: 'lb', workouts: [], routines: [] }, baseRev: 0 }) }).catch(e => e)
    expect(err.status).toBe(409)
    expect(err.data.rev).toBe(1)
    expect(err.data.state.unit).toBe('kg')
  })

  it('answers 404 for the server-only routes', async () => {
    signIn()
    await expect(shimApi('/api/push/public-key')).rejects.toMatchObject({ status: 404 })
    await expect(shimApi('/api/coach/chat', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 404, data: { error: 'not available' } })
  })

  it('refuses a document past the Firestore size', async () => {
    signIn()
    const workouts = Array.from({ length: 8000 }, (_, i) => ({ id: 'w' + i, d: '2026-01-01', start: i, note: Array.from({ length: 20 }, () => Math.random().toString(36).slice(2)).join('') }))
    await expect(put({ unit: 'kg', workouts, routines: [] })).rejects.toMatchObject({ status: 413 })
  }, 30000)
})
