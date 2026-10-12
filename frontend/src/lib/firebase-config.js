// Firebase build (VITE_FIREBASE=1): the app talks to Firestore instead of api/server.js
// (lib/firebase-shim.js). The web config is public by design; access is decided by the
// Firestore rules of the misc-3dcd0 project (repo firebase-misc).
export const FIREBASE = import.meta.env.VITE_FIREBASE === '1'

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAkmvtCvXzrwtR_9ZSN-V9CZdQsoJ8yCxA',
  authDomain: 'misc-3dcd0.firebaseapp.com',
  projectId: 'misc-3dcd0',
  appId: '1:519739349394:web:2f1a11e4001b273d07494b',
  messagingSenderId: '519739349394',
}
