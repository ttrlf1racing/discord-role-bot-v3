const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

// Store config for a guild
async function setConfig(guildId, config) {
  await redis.set(`config:${guildId}`, JSON.stringify(config));
}

// Retrieve config for a guild
async function getConfig(guildId) {
  const raw = await redis.get(`config:${guildId}`);
  return raw ? JSON.parse(raw) : null;
}

// Delete config for a guild
async function deleteConfig(guildId) {
  await redis.del(`config:${guildId}`);
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

module.exports = {
  setConfig,
  getConfig,
  deleteConfig,
  setOnboarding,
  getOnboarding
};
