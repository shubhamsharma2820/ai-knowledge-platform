import { redis } from "../../db/redis.js"

export const CREATE_SESSION_SCRIPT = `
local version = redis.call('GET', KEYS[3])

if not version then
  version = '0'
end

local session = cjson.decode(ARGV[1])
session.sessionVersion = tonumber(version)

redis.call(
  'SET',
  KEYS[1],
  cjson.encode(session),
  'EX',
  ARGV[2]
)

redis.call('SADD', KEYS[2], ARGV[3])

return version
`;

export async function logoutSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  const sessionKey = `session:${sessionId}`;
  const userSessionsKey = `user-sessions:${userId}`;

  await redis
    .multi()
    .del(sessionKey)
    .sRem(userSessionsKey, sessionId)
    .exec();
}

const LOGOUT_ALL_SCRIPT = `
local version = redis.call('INCR', KEYS[1])
local sessionIds = redis.call('SMEMBERS', KEYS[2])

for _, sessionId in ipairs(sessionIds) do
  redis.call('DEL', ARGV[1] .. sessionId)
end

redis.call('DEL', KEYS[2])

return version
`;

export async function logoutAllSessions(
  userId: string,
): Promise<void> {
  await redis.eval(LOGOUT_ALL_SCRIPT, {
    keys: [
      `user-session-version:${userId}`,
      `user-sessions:${userId}`,
    ],
    arguments: ['session:'],
  });
}

