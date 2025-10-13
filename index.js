require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags
} = require('discord.js');
const kv = require('./kvRedis'); // Redis-backed config store
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});
const token = process.env.DISCORD_TOKEN?.trim();
if (!token || token.length < 10) {
  console.error('❌ DISCORD_TOKEN missing or malformed.');
  process.exit(1);
}
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  client.guilds.cache.forEach(async guild => {
    const commands = [
      new SlashCommandBuilder()
        .setName('create-role-message')
        .setDescription('Configure onboarding role, channel, and message')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign').setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post message').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('message').setDescription('Message with {user} and {role}').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('delete-role-message')
        .setDescription('Delete onboarding message for a role')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to delete').setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName('list-role-messages')
        .setDescription('List all configured onboarding messages')
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(`✅ Slash commands registered for ${guild.name}`);
  });
});
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  if (!addedRoles.size) return;

  for (const [roleId, role] of addedRoles) {
    const config = await kv.getConfig(guildId, roleId);
    if (!config || !config.channelId || !config.message) continue;

    const onboardingSet = await kv.getOnboarding(guildId);
    if (onboardingSet.has(newMember.id)) continue;

    const username = newMember.nickname || newMember.user.username;
    const channel = newMember.guild.channels.cache.get(config.channelId);
    if (!channel) continue;

    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_${newMember.id}_${roleId}`)
      .setLabel('✅ I’ve read it')
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    const message = config.message
      .replace('{user}', username)
      .replace('{role}', role.name);

    await channel.send({ content: message, components: [row] });
    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);
    await newMember.roles.remove(roleId);
  }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  const [_, userId, roleId] = interaction.customId.split('_');
  const guildId = interaction.guild.id;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: '❌ This button is not for you.', ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(userId);
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({ content: '❌ Role not found.', ephemeral: true });
    return;
  }

  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(userId);
  await kv.setOnboarding(guildId, onboardingSet);

  await member.roles.add(role);
  await interaction.reply({ content: '✅ Role assigned. Welcome!', ephemeral: true });
});
client.login(token);
