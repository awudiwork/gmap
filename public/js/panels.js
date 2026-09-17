/**
 * 四个弹层：设置、个人资料、上传 Key、用户管理。
 *
 * 共用约定：
 *  - 表单提交走 bindSubmit，成功失败都落在同一个提示位上，不弹 toast 打断视线；
 *    只有列表里的即时操作用 toast，因为结果在列表上已经可见。
 *  - 危险动作两段式确认，不用 window.confirm。
 */
import { api, ApiError } from './api.js'
import { settings, unmute } from './settings.js'
import { el, formatDateTime, icon, openSheet, toast, toggle } from './ui.js'

function textInput({ type = 'text', placeholder = '', value = '', maxLength } = {}) {
  const input = el('input')
  input.type = type
  input.placeholder = placeholder
  input.value = value
  input.autocomplete = type === 'password' ? 'new-password' : 'off'
  if (maxLength) input.maxLength = maxLength
  return input
}

function field(labelText, input) {
  const wrap = el('div', 'field')
  wrap.append(el('label', null, labelText), input)
  return wrap
}

function button(label, { variant = '', glyph = '' } = {}) {
  const node = el('button', variant)
  if (glyph) node.append(icon(glyph))
  node.append(el('span', null, label))
  return node
}

/** 一次提交的成功失败收敛到同一个提示位，省得每个面板各写一套 */
function bindSubmit(node, note, handler) {
  node.addEventListener('click', async () => {
    node.disabled = true
    note.className = 'note'
    note.textContent = '处理中'
    try {
      note.className = 'note good'
      note.textContent = await handler()
    } catch (err) {
      note.className = 'note bad'
      note.textContent = err instanceof ApiError ? err.message : '操作失败'
    } finally {
      node.disabled = false
    }
  })
}

/** 选项少且互斥时用分段按钮，当前值一眼可见，比下拉框直接 */
function picker(options, currentValue, onPick) {
  const wrap = el('div', 'pick')
  const nodes = new Map()
  for (const [value, label] of options) {
    const node = el('button', value === currentValue ? 'on' : '', label)
    node.type = 'button'
    node.addEventListener('click', () => {
      for (const [otherValue, otherNode] of nodes) otherNode.classList.toggle('on', otherValue === value)
      onPick(value)
    })
    nodes.set(value, node)
    wrap.append(node)
  }
  return wrap
}

/** 一条带拨钮的设置项 */
function settingRow(title, description, checked, onChange) {
  const row = el('div', 'setting')
  const body = el('div', 'body')
  body.append(el('strong', null, title), el('span', null, description))
  const knob = toggle({ checked, onChange })
  row.append(knob, body)
  return { row, knob }
}

/* ── 设置 ─────────────────────────────────────────────── */

export function openSettings() {
  const { body } = openSheet('设置')
  const current = settings.get()

  const block = el('div', 'block')
  block.append(
    el('h3', null, '雷达同步'),
    el('div', 'lede', '房间里出现新图时自动展开大图。看图器已经打开时不会重复弹窗，而是在你当前的缩放视角上换图。'),
  )

  const main = settingRow('收到新图自动展开', '地图同步的主开关', current.autoOpenImages, (next) => {
    settings.set({ autoOpenImages: next })
    syncDisabled()
  })
  block.append(main.row)

  const sourceRow = el('div', 'setting')
  const sourceBody = el('div', 'body')
  sourceBody.append(
    el('strong', null, '展开哪些来源'),
    el('span', null, 'API 指带 Key 调上传接口推来的图，也就是你的截图客户端。在网页里粘贴或拖进来的算 WEB。'),
  )
  const sourcePick = picker(
    [['api', '仅 API'], ['all', '全部来源']],
    current.autoOpenSource,
    (value) => settings.set({ autoOpenSource: value }),
  )
  sourceBody.append(sourcePick)
  sourceRow.append(el('span', null, ''), sourceBody)
  block.append(sourceRow)

  const ownPush = settingRow(
    '展开自己推送的图',
    '默认关闭。一个人用两块屏、想让游戏机推的图在这边弹出来时才需要打开',
    current.autoOpenOwnPush,
    (next) => settings.set({ autoOpenOwnPush: next }),
  )
  const beep = settingRow('展开时给一声提示', '短促的一声，方便你在游戏里察觉', current.sound, (next) => settings.set({ sound: next }))
  block.append(ownPush.row, beep.row)

  block.append(el('div', 'lede', '你自己在网页里手动发的图一律不展开，刚发完就在眼前，这条没有开关。'))

  // 在线名单里每个人都有开关，但人一离线就从名单上消失了，
  // 没有这一段就再也关不回来
  const mutedBlock = el('div', 'block')
  mutedBlock.append(
    el('h3', null, '单独关掉的人'),
    el('div', 'lede', '这些人推的图不会自动展开，消息照常收。在线名单里每个人名字右边也有同一个开关。'),
  )
  const mutedList = el('div', 'ledger')
  mutedBlock.append(mutedList)

  function renderMuted() {
    const muted = settings.get().mutedUsers
    mutedList.replaceChildren()
    mutedBlock.classList.toggle('hidden', muted.length === 0)
    // 总开关关着时谁的图都不会弹，这一段同样失去意义
    mutedBlock.classList.toggle('off', !settings.get().autoOpenImages)
    for (const entry of muted) {
      const item = el('div', 'ledger-row')
      const info = el('div', 'info')
      info.append(el('div', 'name', entry.name || `用户 ${entry.id}`))
      item.append(info)

      const restore = button('恢复', { glyph: 'bell-simple' })
      restore.addEventListener('click', () => {
        unmute(entry.id)
        renderMuted()
      })
      item.append(restore)
      mutedList.append(item)
    }
  }
  /** 主开关关掉时把从属项置灰，免得出现"设了但不生效"的状态 */
  function syncDisabled() {
    const on = settings.get().autoOpenImages
    for (const row of [sourceRow, ownPush.row, beep.row]) row.classList.toggle('off', !on)
    ownPush.knob.disabled = !on
    beep.knob.disabled = !on
    for (const node of sourcePick.querySelectorAll('button')) node.disabled = !on
    renderMuted()
  }
  syncDisabled()

  const viewer = el('div', 'block')
  viewer.append(
    el('h3', null, '看图器'),
    el('div', 'lede', '默认每次打开都适应窗口。开了记住缩放，新图就按你上次调好的倍数显示，盯着地图某个角落时不用反复放大。'),
  )

  const remember = settingRow(
    '记住缩放',
    '下次打开或收到新图时，沿用上次的缩放倍数',
    current.rememberView,
    (next) => {
      settings.set({ rememberView: next })
      syncViewer()
    },
  )
  const center = settingRow(
    '位置居中',
    '沿用缩放时把位置放回画面中心。关掉则连上次盯着的位置一起沿用',
    current.centerOnOpen,
    (next) => settings.set({ centerOnOpen: next }),
  )
  viewer.append(remember.row, center.row)

  function syncViewer() {
    const on = settings.get().rememberView
    center.row.classList.toggle('off', !on)
    center.knob.disabled = !on
  }
  syncViewer()

  viewer.append(el('div', 'lede', '这两个开关在看图器右上角也有一份，改哪边都一样。'))

  const scope = el('div', 'block')
  scope.append(
    el('h3', null, '作用范围'),
    el('div', 'lede', '这些设置存在这台设备上，不跟账号走。你在游戏机上和在手机上可以是两套。'),
  )

  body.append(block, mutedBlock, viewer, scope)
}

/* ── 个人资料 ─────────────────────────────────────────── */

export function openProfile(me, onUpdated) {
  const { body } = openSheet('个人资料')

  const nameBlock = el('div', 'block')
  nameBlock.append(
    el('h3', null, '昵称'),
    el('div', 'lede', `登录名 ${me.username}${me.isAdmin ? '，管理员' : ''}。登录名不能改，昵称会显示在日志和在线列表里。`),
  )
  const nameInput = textInput({ value: me.name, maxLength: 24, placeholder: '最长 24 个字符' })
  const nameBtn = button('保存昵称', { variant: 'key' })
  const nameNote = el('div', 'note')
  nameBlock.append(field('昵称', nameInput), nameBtn, nameNote)

  bindSubmit(nameBtn, nameNote, async () => {
    const { user } = await api.updateProfile({ displayName: nameInput.value.trim() })
    onUpdated(user)
    return '昵称已更新'
  })

  const passBlock = el('div', 'block')
  passBlock.append(el('h3', null, '修改密码'))

  if (me.isAdmin) {
    passBlock.append(el('div', 'lede', '管理员密码由 .env 里的 ADMIN_PASSWORD 决定，每次启动都会同步。要改密码请改 .env 后重启服务。'))
  } else {
    passBlock.append(el('div', 'lede', '改完之后，你在其它设备上的登录会被踢下线，当前设备保持登录。'))
    const currentInput = textInput({ type: 'password', placeholder: '当前密码' })
    const nextInput = textInput({ type: 'password', placeholder: '新密码，8 到 72 字节' })
    const confirmInput = textInput({ type: 'password', placeholder: '再输一次' })
    const passBtn = button('修改密码', { variant: 'key' })
    const passNote = el('div', 'note')
    passBlock.append(
      field('当前密码', currentInput),
      field('新密码', nextInput),
      field('确认新密码', confirmInput),
      passBtn,
      passNote,
    )

    bindSubmit(passBtn, passNote, async () => {
      if (nextInput.value !== confirmInput.value) {
        throw new ApiError(0, 'password_mismatch', '两次输入的新密码不一致')
      }
      await api.updateProfile({ currentPassword: currentInput.value, newPassword: nextInput.value })
      currentInput.value = ''
      nextInput.value = ''
      confirmInput.value = ''
      return '密码已更新，其它设备需要重新登录'
    })
  }

  body.append(nameBlock, passBlock)
}

/* ── 上传 Key ─────────────────────────────────────────── */

export async function openKeys() {
  const { body } = openSheet('上传 Key')

  const block = el('div', 'block')
  block.append(
    el('h3', null, '我的 Key'),
    el('div', 'lede', '截图客户端拿 Key 调上传接口，把裁好的地图推进房间。明文只在创建时显示一次，丢了就删掉重建。'),
  )
  const ledger = el('div', 'ledger')
  block.append(ledger)

  const nameInput = textInput({ placeholder: 'Key 名称，例如：游戏本截图工具', maxLength: 32 })
  const createBtn = button('生成', { variant: 'key', glyph: 'plus' })
  const row = el('div', 'inline-row')
  row.append(nameInput, createBtn)
  const note = el('div', 'note')
  block.append(row, note)

  /* 客户端对接。两个接口用的是同一把 Key，都不需要另外登录 */

  const roomsDoc = el('div', 'block')
  roomsDoc.append(
    el('h3', null, '取频道清单'),
    el('div', 'lede', '别在客户端里写死频道。从这个接口读，以后加了新游戏，客户端不用跟着改。'),
  )
  const roomsSnippet = el('pre', 'snippet')
  roomsSnippet.textContent = [
    `curl ${location.origin}/api/rooms \\`,
    '  -H "Authorization: Bearer <你的Key>"',
  ].join('\n')
  roomsDoc.append(roomsSnippet)

  const uploadDoc = el('div', 'block')
  uploadDoc.append(
    el('h3', null, '推图'),
    el('div', 'lede', '一次 multipart 上传。字段名固定是 file，room 指定推到哪个频道，caption 是说明文字。不带 room 会落到「全部」。'),
  )
  const uploadSnippet = el('pre', 'snippet')
  uploadSnippet.textContent = [
    `curl -X POST ${location.origin}/api/upload \\`,
    '  -H "Authorization: Bearer <你的Key>" \\',
    '  -F "file=@map.png" \\',
    '  -F "room=wardogs" \\',
    '  -F "caption=北区刷新"',
  ].join('\n')
  uploadDoc.append(
    uploadSnippet,
    el('div', 'lede', '两次上传之间至少隔 1 秒，太快会收到 429 和 upload_too_fast。那不是错误，等一下重发就行，别当成网络故障一直重试。'),
  )

  body.append(block, roomsDoc, uploadDoc)

  function renderKeys(keys) {
    ledger.replaceChildren()
    if (keys.length === 0) {
      ledger.append(el('div', 'lede', '还没有 Key，在下面生成一个。'))
      return
    }
    for (const key of keys) {
      const item = el('div', 'ledger-row')
      const info = el('div', 'info')
      info.append(
        el('div', 'name', key.name),
        el('div', 'meta', `${key.prefix}  最后使用 ${formatDateTime(key.lastUsedAt)}`),
      )
      item.append(info)

      // 两段式确认：删掉就没了，客户端会立刻掉线
      const dropBtn = button('删除', { variant: 'warn slim', glyph: 'trash' })
      let armed = false
      let timer = null
      const disarm = () => {
        armed = false
        dropBtn.replaceChildren(icon('trash'), el('span', null, '删除'))
      }
      dropBtn.addEventListener('click', async () => {
        if (!armed) {
          armed = true
          dropBtn.replaceChildren(icon('warning-circle'), el('span', null, '确认删除'))
          timer = setTimeout(disarm, 5000)
          return
        }
        clearTimeout(timer)
        dropBtn.disabled = true
        try {
          await api.deleteKey(key.id)
          await refresh()
          toast(`已删除 ${key.name}，用它的客户端会立刻掉线`)
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '删除失败', 'bad')
          dropBtn.disabled = false
          disarm()
        }
      })
      item.append(dropBtn)
      ledger.append(item)
    }
  }

  async function refresh() {
    const { keys } = await api.keys()
    renderKeys(keys)
  }

  bindSubmit(createBtn, note, async () => {
    const { plain } = await api.createKey(nameInput.value.trim())
    nameInput.value = ''
    await refresh()

    const card = el('div', 'reveal')
    card.append(el('strong', null, '这是新 Key，只显示这一次'))
    card.append(el('div', 'secret', plain))
    const copyBtn = button('复制到剪贴板', { glyph: 'copy' })
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(plain)
        copyBtn.replaceChildren(icon('check'), el('span', null, '已复制'))
      } catch {
        copyBtn.replaceChildren(icon('warning-circle'), el('span', null, '复制失败，请手动选中'))
      }
    })
    card.append(copyBtn)
    block.append(card)
    return '已生成，填进截图客户端的配置里'
  })

  try {
    await refresh()
  } catch (err) {
    ledger.append(el('div', 'note bad', err instanceof ApiError ? err.message : '加载失败'))
  }
}

/* ── 用户管理 ─────────────────────────────────────────── */

export async function openUsers(me) {
  const { body } = openSheet('用户管理')

  const listBlock = el('div', 'block')
  listBlock.append(el('h3', null, '账号'))
  const ledger = el('div', 'ledger')
  listBlock.append(ledger)

  const createBlock = el('div', 'block')
  createBlock.append(
    el('h3', null, '新建账号'),
    el('div', 'lede', '创建后把用户名和密码线下告诉对方。对方登录后可以自己改昵称和密码。'),
  )

  const usernameInput = textInput({ placeholder: '3 到 20 位字母数字或 _ -' })
  const displayInput = textInput({ placeholder: '留空则与登录名相同', maxLength: 24 })
  // 初始密码用明文框：管理员要把它抄给对方，遮住反而容易抄错
  const passwordInput = textInput({ placeholder: '至少 8 位' })

  createBlock.append(
    field('登录名', usernameInput),
    field('昵称', displayInput),
    field('初始密码', passwordInput),
  )

  const createBtn = button('创建账号', { variant: 'key', glyph: 'plus' })
  const note = el('div', 'note')
  createBlock.append(createBtn, note)

  body.append(listBlock, createBlock)

  /** 在目标行下方展开重置面板，不用 prompt 弹窗 */
  function resetPanel(user, anchor) {
    const card = el('div', 'reveal')
    card.append(el('strong', null, `为 ${user.name} 设置新密码`))
    const input = textInput({ placeholder: '新密码，8 到 72 字节' })
    const confirmBtn = button('确认重置', { variant: 'key' })
    const cancelBtn = button('取消', { variant: 'bare' })
    const cardNote = el('div', 'note')
    const acts = el('div', 'inline-row')
    acts.append(confirmBtn, cancelBtn)
    card.append(field('新密码', input), acts, cardNote)

    cancelBtn.addEventListener('click', () => card.remove())
    bindSubmit(confirmBtn, cardNote, async () => {
      await api.resetUserPassword(user.id, input.value)
      await refresh()
      return `已重置，把新密码告诉 ${user.name}，他需要重新登录`
    })

    anchor.after(card)
    input.focus()
  }

  function renderUsers(users) {
    ledger.replaceChildren()
    for (const user of users) {
      const item = el('div', 'ledger-row')
      const info = el('div', 'info')
      info.append(
        el('div', 'name', `${user.name}${user.isAdmin ? '，管理员' : ''}${user.id === me.id ? '，本机' : ''}`),
        el('div', 'meta', `${user.username}  创建于 ${formatDateTime(user.createdAt)}`),
      )
      item.append(info)

      // 管理员账号由 .env 掌管，密码和存在与否都不该从页面上改
      if (!user.isAdmin) {
        const resetBtn = button('重置密码', { variant: 'slim', glyph: 'arrow-counter-clockwise' })
        resetBtn.addEventListener('click', () => {
          if (item.nextElementSibling?.classList.contains('reveal')) {
            item.nextElementSibling.remove()
            return
          }
          resetPanel(user, item)
        })

        // 两段式确认：第一次点亮成确认态，5 秒不再点就复位
        const deleteBtn = button('注销', { variant: 'warn slim', glyph: 'trash' })
        let armed = false
        let timer = null
        const disarm = () => {
          armed = false
          deleteBtn.replaceChildren(icon('trash'), el('span', null, '注销'))
        }
        deleteBtn.addEventListener('click', async () => {
          if (!armed) {
            armed = true
            deleteBtn.replaceChildren(icon('warning-circle'), el('span', null, '确认注销'))
            timer = setTimeout(disarm, 5000)
            return
          }
          clearTimeout(timer)
          deleteBtn.disabled = true
          try {
            await api.deleteUser(user.id)
            await refresh()
            toast(`已注销 ${user.name}，登录和 Key 立即失效，日志保留`)
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '注销失败', 'bad')
            deleteBtn.disabled = false
            disarm()
          }
        })

        item.append(resetBtn, deleteBtn)
      }

      ledger.append(item)
    }
  }

  async function refresh() {
    const { users } = await api.users()
    renderUsers(users)
  }

  bindSubmit(createBtn, note, async () => {
    const password = passwordInput.value
    const { user } = await api.createUser({
      username: usernameInput.value.trim(),
      password,
      displayName: displayInput.value.trim(),
    })
    usernameInput.value = ''
    displayInput.value = ''
    passwordInput.value = ''
    await refresh()
    return `已创建 ${user.username}，初始密码 ${password}`
  })

  try {
    await refresh()
  } catch (err) {
    ledger.append(el('div', 'note bad', err instanceof ApiError ? err.message : '加载失败'))
  }
}
