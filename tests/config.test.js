/**
 * 配置层的回归测试。config 在 import 时求值且冻结，
 * 所以这里起子进程，一组环境变量跑一次，看它是启动还是拒绝。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 用给定环境变量加载 config，返回退出码和输出 */
function loadConfig(env) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "const { config } = await import('./server/config.js'); console.log(JSON.stringify({ upload: config.uploadDir, data: config.dataDir, retentionMs: config.retentionMs }))",
  ], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('上传目录和数据目录不能重叠', () => {
  const same = loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './tmp-cfg/data' })
  assert.equal(same.code, 1)
  assert.match(same.err, /UPLOAD_DIR/)

  const nested = loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './tmp-cfg/data/uploads' })
  assert.equal(nested.code, 1)

  const parent = loadConfig({ DATA_DIR: './tmp-cfg/data/db', UPLOAD_DIR: './tmp-cfg/data' })
  assert.equal(parent.code, 1)
})

test('上传目录不能是项目目录、它的上级或代码目录', () => {
  assert.equal(loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: '.' }).code, 1, '项目根')
  assert.equal(loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: '..' }).code, 1, '上级目录')
  assert.equal(loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './public/uploads' }).code, 1, '代码目录里')
})

test('正常的目录组合能启动，且保留期换算成毫秒', () => {
  const ok = loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './tmp-cfg/uploads', RETENTION_HOURS: '2' })
  assert.equal(ok.code, 0, ok.err)
  const parsed = JSON.parse(ok.out.trim().split('\n').pop())
  assert.equal(parsed.retentionMs, 2 * 60 * 60 * 1000)
  assert.ok(path.isAbsolute(parsed.upload))
})

test('非法数值让启动失败而不是带病运行', () => {
  assert.equal(loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './tmp-cfg/uploads', UPLOAD_RATE_PER_MINUTE: 'lots' }).code, 1)
  assert.equal(loadConfig({ DATA_DIR: './tmp-cfg/data', UPLOAD_DIR: './tmp-cfg/uploads', LOGIN_RATE_PER_MINUTE: '0' }).code, 1)
})
