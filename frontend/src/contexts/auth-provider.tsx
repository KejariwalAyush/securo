import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { auth, WORKSPACE_STORAGE_KEY } from '@/lib/api'
import type { User } from '@/types'

import { AuthContext, type LoginResult } from '@/contexts/auth-context'
import {
  firebaseEnabled,
  firebaseLoginWithEmail,
  firebaseRegisterWithEmail,
  firebaseLoginWithGoogle,
  firebaseLogout,
  onFirebaseAuthChange,
} from '@/lib/firebase'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'))
  const [isLoading, setIsLoading] = useState(true)
  const queryClient = useQueryClient()

  if (!token && (user !== null || isLoading)) {
    setUser(null)
    setIsLoading(false)
  }

  useEffect(() => {
    if (!token) return
    let cancelled = false
    auth.me()
      .then((me) => { if (!cancelled) setUser(me) })
      .catch(() => {
        if (cancelled) return
        localStorage.removeItem('token')
        setToken(null)
      })
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [token])

  // Sync token across tabs via storage events
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'token') {
        setToken(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // Firebase token refresh: keep localStorage in sync when Firebase rotates the ID token
  useEffect(() => {
    if (!firebaseEnabled) return
    const unsubscribe = onFirebaseAuthChange(async (fbUser) => {
      if (fbUser) {
        const newToken = await fbUser.getIdToken()
        localStorage.setItem('token', newToken)
        setToken(newToken)
      }
    })
    return unsubscribe
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<LoginResult> => {
    if (firebaseEnabled) {
      const idToken = await firebaseLoginWithEmail(email, password)
      localStorage.setItem('token', idToken)
      setToken(idToken)
      const me = await auth.me()
      setUser(me)
      return { requires_2fa: false }
    }

    const data = await auth.login(email, password)

    if (data.requires_2fa) {
      return { requires_2fa: true, temp_token: data.temp_token, available_methods: data.available_methods }
    }

    const accessToken = data.access_token
    localStorage.setItem('token', accessToken)
    setToken(accessToken)
    const me = await auth.me()
    setUser(me)
    return { requires_2fa: false }
  }, [])

  const verify2fa = useCallback(async (tempToken: string, code: string) => {
    const data = await auth.verify2fa(tempToken, code)
    localStorage.setItem('token', data.access_token)
    setToken(data.access_token)
    const me = await auth.me()
    setUser(me)
  }, [])

  const loginWithToken = useCallback((accessToken: string) => {
    localStorage.setItem('token', accessToken)
    setToken(accessToken)
    auth.me().then(setUser).catch(() => {})
  }, [])

  const loginWithGoogle = useCallback(async () => {
    const idToken = await firebaseLoginWithGoogle()
    localStorage.setItem('token', idToken)
    setToken(idToken)
    const me = await auth.me()
    setUser(me)
  }, [])

  const updateUser = useCallback((updatedUser: User) => {
    setUser(updatedUser)
  }, [])

  const register = useCallback(async (email: string, password: string, preferences?: Record<string, string>) => {
    if (firebaseEnabled) {
      const idToken = await firebaseRegisterWithEmail(email, password)
      localStorage.setItem('token', idToken)
      setToken(idToken)
      const me = await auth.me()
      setUser(me)
      return
    }
    await auth.register(email, password, preferences)
    await login(email, password)
  }, [login])

  const logout = useCallback(async () => {
    if (firebaseEnabled) {
      await firebaseLogout().catch(() => {})
    }
    localStorage.removeItem('token')
    localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    setToken(null)
    setUser(null)
    queryClient.clear()
  }, [queryClient])

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, verify2fa, loginWithToken, loginWithGoogle, register, updateUser, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
