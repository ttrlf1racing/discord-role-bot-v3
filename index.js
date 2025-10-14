require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits
} = require("discord.js");
const { MessageFlags } = require("discord-api-types/v10");
const kv = require("./kvRedis");

const recentlyConfirmed = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// --- Register Slash Commands ---
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  for (const [guildId, guild] of client.guilds.cache) {
    const commands = [
      new SlashCommandBuilder()
        .setName("create-role-message")
        .setDescription("Set onboarding message for a role")
        .addRoleOption(opt =>
          opt.setName("role").setDescription("Role to link message to").setRequired(true)
        )
        .addChannelOption(opt =>
          opt
            .setName("channel")
            .setDescription("Channel to post onboarding message")
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName("message")
            .setDescription("Onboarding message (use {user} and {role})")
            .setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName("list-role-messages")
        .setDescription("List all role onboarding messages"),

      new SlashCommandBuilder()
        .setName("delete-role-message")
        .setDescription("Delete onboarding message for a role")
        .addRoleOption(opt =>
          opt.setName("role").setDescription("Role to remove message for").setRequired(true)
        )
    ].map(c => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(token);
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
        body: commands
      });
      console.log(`✅ Commands registered for ${guild.name}`);
    } catch (err) {
      console.error(`❌ Failed to register commands for ${guild.name}:`, err);
    }
  }
});

// --- Slash Command Handler ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild())
    return interaction.reply({
      content: "❌ Use commands inside a server.",
      flags: MessageFlags.Ephemeral
    });

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (!isAdmin)
    return interaction.reply({
      content: "❌ You must be an Administrator.",
      flags: MessageFlags.Ephemeral
    });

  // Create / update onboarding message for a role
  if (interaction.commandName === "create-role-message") {
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");

    config.messages[role.id] = { channelId: channel.id, message };
    await kv.setConfig(guildId, config);

    await interaction.reply(
      `✅ Onboarding message set for role **${role.name}** in **${channel.name}**`
    );
  }

  // List all
  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});
    if (entries.length === 0)
      return interaction.reply({
        content: "⚠️ No role messages configured.",
        flags: MessageFlags.Ephemeral
      });

    const list = entries
      .map(
        ([roleId, data]) =>
          `• <@&${roleId}> → <#${data.channelId}> (${data.message.length} chars)`
      )
      .join("\n");

    return interaction.reply({
      content: `📋 Configured Onboarding Messages:\n${list}`,
      flags: MessageFlags.Ephemeral
    });
  }

  // Delete
  if (interaction.commandName === "delete-role-message") {
    const role = interaction.options.getRole("role");
    if (!config.messages[role.id])
      return interaction.reply({
        content: `⚠️ No message found for **${role.name}**.`,
        flags: MessageFlags.Ephemeral
      });

    delete config.messages[role.id];
    await kv.setConfig(guildId, config);
    await interaction.reply(`🗑️ Deleted onboarding message for role **${role.name}**.`);
  }
});

// --- Role Added → Send Onboarding Message ---
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const config = await kv.getConfig(guildId);
  if (!config?.messages) return;

  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  if (addedRoles.size === 0) return;

  const onboardingSet = await kv.getOnboarding(guildId);

  for (const role of addedRoles.values()) {
    const flow = config.messages[role.id];
    if (!flow) continue;

    if (recentlyConfirmed.get(guildId)?.has(newMember.id)) continue;
    if (onboardingSet.has(newMember.id)) continue;

    const username = newMember.nickname || newMember.user.username;
    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_${role.id}_${newMember.id}`)
      .setLabel("✅ I’ve read it")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(confirmButton);
    const channel = newMember.guild.channels.cache.get(flow.channelId);

    if (channel) {
      const formattedMessage = flow.message
        .replace(/{user}/g, `<@${newMember.id}>`)
        .replace(/{role}/g, `<@&${role.id}>`)
        .replace(/\r?\n/g, "\n");

      await channel.send({
        content: formattedMessage,
        allowedMentions: { users: [newMember.id], roles: [role.id] },
        components: [row]
      });
      console.log(`📨 Sent onboarding for ${username} in #${channel.name} (role ${role.name})`);
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(role.id);
      console.log(`⏳ Temporarily removed ${role.name} from ${username}`);
    } catch (e) {
      console.error("❌ Failed to remove role:", e);
    }
  }
});

// --- Button Confirm Handler ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("confirm_")) return;

  const [, roleId, memberId] = interaction.customId.split("_");
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[roleId];
  if (!flow) return;

  const member = await interaction.guild.members.fetch(memberId);
  if (interaction.user.id !== memberId)
    return interaction.reply({
      content: "❌ This button isn’t for you.",
      flags: MessageFlags.Ephemeral
    });

  const onboardingSet = await kv.getOnboarding(guildId);
  onboardingSet.delete(member.id);
  await kv.setOnboarding(guildId, onboardingSet);

  if (!recentlyConfirmed.has(guildId)) recentlyConfirmed.set(guildId, new Set());
  recentlyConfirmed.get(guildId).add(member.id);

  try {
    await member.roles.add(roleId);
    await interaction.reply({
      content: "✅ Role assigned. Welcome aboard!",
      flags: MessageFlags.Ephemeral
    });
    console.log(`🎯 ${member.user.tag} confirmed and got role ${roleId}`);
  } catch (e) {
    console.error("❌ Role assign error:", e);
    await interaction.reply({
      content: "❌ Failed to assign role.",
      flags: MessageFlags.Ephemeral
    });
  }

  setTimeout(() => {
    recentlyConfirmed.get(guildId)?.delete(member.id);
  }, 10000);
});

client.login(token);
