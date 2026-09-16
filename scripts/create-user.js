/**
 * 命令行开号脚本（应急用）。
 *
 *   pnpm create-user <用户名> [昵称]
 *
 * 常规开号请用管理员账号登录后在页面的「用户管理」里操作；
 * 这个脚本留给"页面进不去"的场景。管理员账号本身由 .env 的
 * ADMIN_USERNAME/ADMIN_PASSWORD 决定，服务启动时自动同步，不需要在这里建。
 *
 * 密码从交互输入读取，不走命令行参数，避免留在 shell 历史里。
 */
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createUser, toPublicUser } from '../server/services/user.service.js'
import { db } from '../server/db.js'

const [username, displayName] = process.argv.slice(2)

if (!username) {
  console.error('用法: pnpm create-user <用户名> [昵称]')
  process.exit(1)
}

const rl = readline.createInterface({ input: stdin, output: stdout })

try {
  const password = await rl.question('请输入密码（输入内容会显示在屏幕上）: ')
  const confirm = await rl.question('请再次输入密码: ')
  if (password !== confirm) {
    console.error('两次输入的密码不一致')
    process.exit(1)
  }

  // 管理员身份只由 .env 决定，这里一律建普通用户
  const user = await createUser({ username, password, displayName, isAdmin: false })
  console.log('已创建用户:', toPublicUser(user))
} catch (err) {
  console.error('创建失败:', err.message)
  process.exitCode = 1
} finally {
  rl.close()
  db.close()
}
