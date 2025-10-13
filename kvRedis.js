const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// Store onboarding message per role
async function setRoleMessage(guildId, roleId, data) {
  await redis.hset(`onboard:${guildId}`, roleId, JSON.stringify(data));
}

// Retrieve onboarding message for a role
async function getRoleMessage(guildId, roleId) {
  const raw = await redis.hget(`onboard:${guildId}`, roleId);
  return raw ? JSON.parse(raw) : null;
}

// Delete onboarding message for a role
async function deleteRoleMessage(guildId, roleId) {
  await redis.hdel(`onboard:${guildId}`, roleId);
}

// List all role messages for a guild
async function listRoleMessages(guildId) {
  const all = await redis.hgetall(`onboard:${guildId}`);
  const parsed = {};
  for (const [roleId, raw] of Object.entries(all)) {
    parsed[roleId] = JSON.parse(raw);
  }
  return parsed;
}

// Store onboarding state (Set of userIds)
async function setOnboarding(guildId, set) {
  await redis.set(`onboarding:${guildId}`, JSON.stringify([...set]));
}

// Retrieve onboarding state
async function getOnboarding(guildId) {
  const raw = await redis.get(`onboarding:${guildId}`);
  return raw ? new Set(JSON.parse(raw)) : new Set();
}

// Optional: Lookup role message by userId (if needed)
async function getRoleMessageByUser(guildId, userId) {
  const all = await listRoleMessages(guildId);
  for (const [roleId, config] of Object.entries(all)) {
    if (config.lastUserId === userId) return { ...config, roleId };
  }
  return null;
}

module.exports = {
  setRoleMessage,
  getRoleMessage,
  deleteRoleMessage,
  listRoleMessages,
  setOnboarding,
  getOnboarding,
  getRoleMessageByUser
};
