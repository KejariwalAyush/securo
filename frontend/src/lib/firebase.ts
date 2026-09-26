import { type FirebaseApp, initializeApp } from 'firebase/app'
import {
  type Auth,
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth'

export const firebaseEnabled = Boolean(import.meta.env.VITE_FIREBASE_API_KEY)

let _app: FirebaseApp | null = null
let _auth: Auth | null = null

function getFirebaseApp(): FirebaseApp {
  if (!_app) {
    _app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'studio-3131737339-ef9ce',
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
      appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
    })
  }
  return _app
}

export function getFirebaseAuth(): Auth {
  if (!_auth) {
    _auth = getAuth(getFirebaseApp())
  }
  return _auth
}

export async function firebaseLoginWithEmail(email: string, password: string) {
  const result = await signInWithEmailAndPassword(getFirebaseAuth(), email, password)
  return result.user.getIdToken()
}

export async function firebaseRegisterWithEmail(email: string, password: string) {
  const result = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password)
  return result.user.getIdToken()
}

export async function firebaseLoginWithGoogle() {
  const result = await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider())
  return result.user.getIdToken()
}

export async function firebaseLogout() {
  await signOut(getFirebaseAuth())
}

export function onFirebaseAuthChange(callback: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(getFirebaseAuth(), callback)
}
