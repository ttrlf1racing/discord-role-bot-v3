require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  ChannelType,
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
        .setDescription("Create an onboarding flow for a role")
        .addStringOption(opt =>
          opt.setName("name").setDescription("Flow name").setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName("role").setDescription("Role to assign after confirm").setRequired(true)
        )
        .addChannelOption(opt =>
          opt
            .setName("channel")
            .setDescription("Channel to post onboarding message")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName("message").setDescription("Message (use {user})").setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName("list-role-messages")
        .setDescription("List all onboarding flows"),

      new SlashCommandBuilder()
        .setName("delete-role-message")
        .setDescription("Delete an onboarding flow")
        .addStringOption(opt =>
          opt.setName("name").setDescription("Flow name").setRequired(true)
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

// --- Command Handler ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "❌ Use commands in a server.",
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  let config = (await kv.getConfig(guildId)) || { messages: {} };

  const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (!isAdmin) {
    return interaction.reply({
      content: "❌ You must be an Administrator.",
      flags: MessageFlags.Ephemeral
    });
  }

  // --- Create Flow ---
  if (interaction.commandName === "create-role-message") {
    const name = interaction.options.getString("name");
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");

    config.messages[name] = {
      roleId: role.id,
      channelId: channel.id,
      message
    };

    await kv.setConfig(guildId, config);
    await interaction.reply(
      `✅ Created onboarding flow **${name}**:\n• Role: **${role.name}**\n• Channel: **${channel.name}**\n• Message: "${message}"`
    );
  }

  // --- List Flows ---
  if (interaction.commandName === "list-role-messages") {
    const entries = Object.entries(config.messages || {});
    if (entries.length === 0)
      return interaction.reply({
        content: "⚠️ No onboarding flows configured.",
        flags: MessageFlags.Ephemeral
      });

    const list = entries
      .map(
        ([n, f]) =>
          `• **${n}** → Role <@&${f.roleId}> in <#${f.channelId}> → "${f.message}"`
      )
      .join("\n");

    return interaction.reply({
      content: `📋 Active Onboarding Flows:\n${list}`,
      flags: MessageFlags.Ephemeral
    });
  }

  // --- Delete Flow ---
  if (interaction.commandName === "delete-role-message") {
    const name = interaction.options.getString("name");
    if (!config.messages[name])
      return interaction.reply({
        content: `⚠️ Flow **${name}** not found.`,
        flags: MessageFlags.Ephemeral
      });

    delete config.messages[name];
    await kv.setConfig(guildId, config);
    return interaction.reply(`🗑️ Deleted onboarding flow **${name}**.`);
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

  for (const [name, flow] of Object.entries(config.messages)) {
    const { roleId, channelId, message } = flow;
    if (!addedRoles.has(roleId)) continue;

    // Skip if recently confirmed
    if (recentlyConfirmed.get(guildId)?.has(newMember.id)) continue;

    // Skip if already onboarding
    if (onboardingSet.has(newMember.id)) {
      if (newMember.roles.cache.has(roleId)) {
        await newMember.roles.remove(roleId).catch(() => {});
      }
      continue;
    }

    const username = newMember.nickname || newMember.user.username;
    const confirmButton = new ButtonBuilder()
      .setCustomId(`confirm_${name}_${newMember.id}`)
      .setLabel("✅ I’ve read it")
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(confirmButton);
    const channel = newMember.guild.channels.cache.get(channelId);

    if (channel) {
      await channel.send({
        content: message.replace("{user}", username),
        components: [row]
      });
      console.log(`📨 Sent onboarding message for ${username} in #${channel.name} (flow: ${name})`);
    }

    onboardingSet.add(newMember.id);
    await kv.setOnboarding(guildId, onboardingSet);

    try {
      await newMember.roles.remove(roleId);
      console.log(`⏳ Temporarily removed role ${roleId} from ${username}`);
    } catch (e) {
      console.error("❌ Role remove error:", e);
    }
  }
});

// --- Button Handler ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("confirm_")) return;

  const [, flowName, memberId] = interaction.customId.split("_");
  const guildId = interaction.guild.id;
  const config = await kv.getConfig(guildId);
  const flow = config?.messages?.[flowName];
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
    await member.roles.add(flow.roleId);
    await interaction.reply({
      content: "✅ Role assigned. Welcome aboard!",
      flags: MessageFlags.Ephemeral
    });
    console.log(`🎯 ${member.user.tag} confirmed and got role ${flow.roleId} (flow: ${flowName})`);
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
