/**
 * 后端接口封装。
 *
 * 契约：
 *  - 所有方法在 HTTP 非 2xx 时抛 ApiError，带上后端返回的 code 与中文 message，
 *    调用方按 code 分支，不解析文案。
 *  - 401 统一由调用方决定是否跳登录页，这里不做副作用跳转，
 *    避免登录页自身调用 /me 时陷入循环。
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function parse(response) {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // 非 JSON 响应（如反向代理返回的错误页）
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.code ?? 'http_error',
      payload?.message ?? `请求失败（HTTP ${response.status}）`,
    )
  }
  return payload
}

const jsonRequest = (method) => (url, body) =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(parse)

const get = (url) => fetch(url).then(parse)
const post = jsonRequest('POST')
const patch = jsonRequest('PATCH')
const del = jsonRequest('DELETE')

export const api = {
  authConfig: () => get('/api/auth/config'),
  me: () => get('/api/auth/me'),
  login: (payload) => post('/api/auth/login', payload),
  register: (payload) => post('/api/auth/register', payload),
  logout: () => post('/api/auth/logout'),

  rooms: () => get('/api/rooms'),

  /** Wardogs 伤害计算器的数据：弹道数值 + 武器图标与解锁等级 */
  wardogsBallistics: () => get('/api/wardogs/ballistics'),

  messages: ({ room, before, limit } = {}) => {
    const query = new URLSearchParams()
    if (room) query.set('room', room)
    if (before) query.set('before', String(before))
    if (limit) query.set('limit', String(limit))
    const suffix = query.toString()
    return get(`/api/messages${suffix ? `?${suffix}` : ''}`)
  },
  sendText: ({ room, kind, body, lang }) => post('/api/messages', { room, kind, body, lang }),

  /** 改自己的昵称和/或密码；改密码需同时给 currentPassword 与 newPassword */
  updateProfile: (payload) => patch('/api/auth/me', payload),

  users: () => get('/api/admin/users'),
  createUser: (payload) => post('/api/admin/users', payload),
  resetUserPassword: (id, password) => patch(`/api/admin/users/${id}/password`, { password }),
  deleteUser: (id) => del(`/api/admin/users/${id}`),

  keys: () => get('/api/keys'),
  createKey: (name) => post('/api/keys', { name }),
  deleteKey: (id) => del(`/api/keys/${id}`),

  /**
   * 上传文件。用 XHR 而非 fetch，因为需要上传进度回调。
   * @returns {Promise<object>} 后端返回的 { message, file }
   */
  upload({ file, caption = '', room, onProgress }) {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file, file.name || 'upload')
      if (caption) form.append('caption', caption)
      if (room) form.append('room', room)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/upload')
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
      })
      xhr.addEventListener('load', () => {
        let payload = null
        try {
          payload = JSON.parse(xhr.responseText)
        } catch {
          // 交给下面的状态码分支处理
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload)
          return
        }
        reject(new ApiError(xhr.status, payload?.code ?? 'http_error', payload?.message ?? `上传失败（HTTP ${xhr.status}）`))
      })
      xhr.addEventListener('error', () => reject(new ApiError(0, 'network_error', '网络错误，上传中断')))
      xhr.addEventListener('abort', () => reject(new ApiError(0, 'aborted', '上传已取消')))
      xhr.send(form)
    })
  },
}
