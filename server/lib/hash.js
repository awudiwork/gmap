/**
 * 凭据的单向摘要。会话 token 和 API Key 都只存这个，明文不落库。
 * 两处共用一份，算法一旦要换（比如加盐）只改这里。
 */
import crypto from 'node:crypto'

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
