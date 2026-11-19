import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { login as loginApi } from '../api/admin'
import { getToken, setToken } from '../api/client'
import { readValue, removeValue, writeValue } from '../lib/storage'

const USER_KEY = 'dsh.market.user'
const AuthContext = createContext(null)

function readUser() {
  try {
    return JSON.parse(readValue(USER_KEY) || 'null')
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (getToken() ? readUser() : null))

  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      removeValue(USER_KEY)
    }
    window.addEventListener('dsh:unauthorized', onUnauthorized)
    return () => window.removeEventListener('dsh:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (username, password) => {
    const res = await loginApi(username, password)
    setToken(res.token)
    writeValue(USER_KEY, JSON.stringify(res.user))
    setUser(res.user)
    return res.user
  }, [])

  const logout = useCallback(() => {
    setToken('')
    removeValue(USER_KEY)
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, login, logout, isAuthed: Boolean(user) }), [user, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
