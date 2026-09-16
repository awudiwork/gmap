import { api, ApiError } from './api.js'

const form = document.getElementById('gate-form')
const switcher = document.getElementById('switcher')
const displayField = document.getElementById('display-field')
const codeField = document.getElementById('code-field')
const submitBtn = document.getElementById('submit-btn')
const note = document.getElementById('gate-note')
const passwordInput = document.getElementById('password')

let mode = 'login'
let requiresCode = false

function say(text, kind = 'bad') {
  note.textContent = text
  note.className = `note ${kind}`
}

function applyMode(next) {
  mode = next
  for (const button of switcher.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.mode === mode)
  }
  const registering = mode === 'register'
  displayField.classList.toggle('hidden', !registering)
  codeField.classList.toggle('hidden', !registering || !requiresCode)
  document.getElementById('gate-title').textContent = registering ? '注册' : '登录'
  submitBtn.textContent = registering ? '注册并进入' : '登录'
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password'
  say('', 'good')
}

switcher.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]')
  if (button && !button.disabled) applyMode(button.dataset.mode)
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  submitBtn.disabled = true
  say('处理中', 'good')

  const payload = {
    username: document.getElementById('username').value.trim(),
    password: passwordInput.value,
  }
  if (mode === 'register') {
    payload.displayName = document.getElementById('displayName').value.trim()
    payload.code = document.getElementById('code').value.trim()
  }

  try {
    if (mode === 'register') await api.register(payload)
    else await api.login(payload)
    location.replace('/')
  } catch (err) {
    say(err instanceof ApiError ? err.message : '请求失败，检查网络')
    submitBtn.disabled = false
  }
})

// 已登录就直接进房间；同时用服务端配置填铭牌和注册入口
try {
  const [{ user }, config] = await Promise.all([api.me(), api.authConfig()])
  if (user) {
    location.replace('/')
  } else {
    requiresCode = config.requiresCode

    document.getElementById('spec-retention').textContent = `${config.fileRetentionHours} 小时后清除`
    document.getElementById('spec-access').textContent = config.allowRegistration
      ? (config.requiresCode ? '凭邀请码自助注册' : '开放自助注册')
      : '由管理员开号'

    if (!config.allowRegistration) {
      switcher.classList.add('hidden')
      document.getElementById('gate-lede').textContent = '不开放自助注册，账号向管理员索取。'
    }
    applyMode('login')
  }
} catch {
  say('连不上服务端，确认服务已经启动')
}
