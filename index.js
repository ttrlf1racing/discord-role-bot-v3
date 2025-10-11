001 | require('dotenv').config();
002 | const {
003 |   Client,
004 |   GatewayIntentBits,
005 |   Partials,
006 |   Events,
007 |   ButtonBuilder,
008 |   ButtonStyle,
009 |   ActionRowBuilder,
010 |   REST,
011 |   Routes,
012 |   SlashCommandBuilder,
013 |   ChannelType
014 | } = require('discord.js');
015 | 
016 | const client = new Client({
017 |   intents: [
018 |     GatewayIntentBits.Guilds,
019 |     GatewayIntentBits.GuildMembers,
020 |     GatewayIntentBits.GuildMessages,
021 |     GatewayIntentBits.MessageContent
022 |   ],
023 |   partials: [Partials.Channel]
024 | });
025 | 
026 | const serverConfig = new Map();
027 | const activeOnboarding = new Map();
028 | 
029 | process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
030 | process.on('uncaughtException', error => console.error('Uncaught exception:', error));
031 | 
032 | const rawToken = process.env.DISCORD_TOKEN;
033 | const token = String(rawToken).trim();
034 | console.log(`🔍 Token received: ${token.slice(0, 10)}...`);
035 | if (!token || typeof token !== 'string' || token.length < 10) {
036 |   console.error('❌ DISCORD_TOKEN is missing or malformed.');
037 |   process.exit(1);
038 | }
039 | 
040 | client.once(Events.ClientReady, async () => {
041 |   console.log(`✅ Logged in as ${client.user.tag}`);
042 | 
043 |   const rest = new REST({ version: '10' }).setToken(token);
044 |   const commands = [
045 |     new SlashCommandBuilder()
046 |       .setName('create-role-message')
047 |       .setDescription('Configure onboarding role, channel, and message')
048 |       .addStringOption(opt =>
049 |         opt.setName('name').setDescription('Name for this onboarding flow').setRequired(true)
050 |       )
051 |       .addRoleOption(opt =>
052 |         opt.setName('role').setDescription('Role to assign after confirmation').setRequired(true)
053 |       )
054 |       .addChannelOption(opt =>
055 |         opt.setName('channel').setDescription('Channel to post onboarding message').addChannelTypes(ChannelType.GuildText).setRequired(true)
056 |       )
057 |       .addStringOption(opt =>
058 |         opt.setName('message').setDescription('Message content (use {user} to insert name)').setRequired(true)
059 |       ),
060 | 
061 |     new SlashCommandBuilder()
062 |       .setName('edit-role-message')
063 |       .setDescription('Edit an existing onboarding role message')
064 |       .addStringOption(opt =>
065 |         opt.setName('name').setDescription('New name (optional)').setRequired(false)
066 |       )
067 |       .addRoleOption(opt =>
068 |         opt.setName('role').setDescription('New role (optional)').setRequired(false)
069 |       )
070 |       .addChannelOption(opt =>
071 |         opt.setName('channel').setDescription('New channel (optional)').addChannelTypes(ChannelType.GuildText).setRequired(false)
072 |       )
073 |       .addStringOption(opt =>
074 |         opt.setName('message').setDescription('New message (optional)').setRequired(false)
075 |       ),
076 | 
077 |     new SlashCommandBuilder()
078 |       .setName('delete-role-message')
079 |       .setDescription('Delete the active onboarding role message'),
080 | 
081 |     new SlashCommandBuilder()
082 |       .setName('list-role-messages')
083 |       .setDescription('View active onboarding role message configuration')
084 |   ].map(cmd => cmd.toJSON());
085 | 
086 |   try {
087 |     const existing = await rest.get(Routes.applicationCommands(client.user.id));
088 |     if (!existing.length) {
089 |       await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
090 |       console.log(`📦 Slash commands registered globally`);
091 |     } else {
092 |       console.log(`📦 Slash commands already registered`);
093 |     }
094 |   } catch (err) {
095 |     console.error(`❌ Failed to register commands:`, err);
096 |   }
097 | });
098 | 
099 | client.on(Events.InteractionCreate, async interaction => {
100 |   if (!interaction.isChatInputCommand()) return;
101 |   if (!interaction.inGuild()) {
102 |     await interaction.reply({ content: '❌ Commands must be used in a server.', ephemeral: true });
103 |     return;
104 |   }
105 | 
106 |   const member = interaction.member;
107 |   const isAdmin = member.roles.cache.some(role => role.name.toLowerCase() === 'admin');
108 |   if (!isAdmin) {
109 |     await interaction.reply({ content: '❌ You must have the Admin role to use this command.', ephemeral: true });
110 |     return;
111 |   }
112 | 
113 |   const guildId = interaction.guild.id;
114 |   if (!serverConfig.has(guildId)) serverConfig.set(guildId, {});
115 |   const config = serverConfig.get(guildId);
116 | 
117 |   if (interaction.commandName === 'create-role-message') {
118 |     const name = interaction.options.getString('name');
119 |     const role = interaction.options.getRole('role');
120 |     const channel = interaction.options.getChannel('channel');
121 |     const message = interaction.options.getString('message');
122 | 
123 |     config.name = name;
124 |     config.roleId = role.id;
125 |     config.channelId = channel.id;
126 |     config.message = message;
127 |     config.lastMessageId = null;
128 | 
129 |     await interaction.reply(`✅ Role message created:\n• Name: **${name}**\n• Role: **${role.name}**\n• Channel: **${channel.name}**\n• Message: "${message}"`);
130 |   }
131 | 
132 |   if (interaction.commandName === 'edit-role-message') {
133 |     const name = interaction.options.getString('name');
134 |     const role = interaction.options.getRole('role');
135 |     const channel = interaction.options.getChannel('channel');
136 |     const message = interaction.options.getString('message');
137 | 
138 |     if (!config.roleId || !config.channelId || !config.message || !config.name) {
139 |       await interaction.reply({ content: '⚠️ No active config to edit.', ephemeral: true });
140 |       return;
141 |     }
142 | 
143 |     if (config.lastMessageId && config.channelId) {
144 |       const oldChannel = interaction.guild.channels.cache.get(config.channelId);
145 |       try {
146 |         const oldMessage = await oldChannel.messages.fetch(config.lastMessageId);
147 |         await oldMessage.delete();
148 |         console.log(`🗑️ Deleted previous onboarding message`);
149 |       } catch (err) {
150 |         console.warn(`⚠️ Could not delete previous message:`, err.message);
151 |       }
152 |       config.lastMessageId = null;
153 |     }
154 | 
155 |     if (name) config.name = name;
156 |     if (role) config.roleId = role.id;
157 |     if (channel) config.channelId = channel.id;
158 |     if (message) config.message = message;
159 | 
160 |     await interaction.reply(`✅ Role message updated:\n• Name: **${config.name}**\n• Role: **${interaction.guild.roles.cache.get(config.roleId)?.name || 'Unknown'}**\n• Channel: **${interaction.guild.channels.cache.get(config.channelId)?.name || 'Unknown'}**\n• Message: "${config.message}"`);
161 |   }
162 | 
163 |   if (interaction.commandName === 'delete-role-message') {
164 |     serverConfig.delete(guildId);
165 |     await interaction.reply('🗑️ Role message configuration deleted.');
166 |   }
167 | 
168 |   if (interaction.commandName === 'list-role-messages') {
169 |     if (!config.roleId || !config.channelId || !config.message || !config.name) {
170 |       await interaction.reply({ content: '⚠️ No active role message configuration found.', ephemeral: true });
171 |       return;
172 |     }
173 | 
174 |     const role = interaction.guild.roles.cache.get(config.roleId);
175 |     const channel = interaction.guild.channels.cache.get(config.channelId);
176 |     const message = config.message;
177 |     const name = config.name;
178 | 
179 |     await interaction.reply({
180 |       content: `📋 Active Role Message Configuration:\n• Name: **${name}**\n• Role: **${role?.name || 'Unknown'}**\n• Channel: **${channel?.name || 'Unknown'}**\n• Message: "${message}"`,
181 |       ephemeral: true
182 |     });
183 |   }
184
185 | client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
186 |   const guildId = newMember.guild.id;
187 |   const config = serverConfig.get(guildId);
188 |   if (!config || !config.roleId || !config.channelId || !config.message) return;
189 | 
190 |   if (!activeOnboarding.has(guildId)) activeOnboarding.set(guildId, new Set());
191 |   const onboardingSet = activeOnboarding.get(guildId);
192 | 
193 |   const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
194 |   if (!addedRoles.has(config.roleId)) return;
195 | 
196 |   if (onboardingSet.has(newMember.id)) {
197 |     console.log(`⏸ ${newMember.user.tag} already in onboarding. Skipping.`);
198 |     return;
199 |   }
200 | 
201 |   try {
202 |     await newMember.roles.remove(config.roleId);
203 |     console.log(`⏳ Role temporarily removed from ${username} until confirmation`);
204 |   } catch (err) {
205 |     console.error(`❌ Failed to remove role from ${username}:`, err);
206 |   }
207 | });
208 | 
209 | // Button interaction handler
210 | client.on(Events.InteractionCreate, async interaction => {
211 |   if (!interaction.isButton()) return;
212 |   if (!interaction.customId.startsWith('confirm_read')) return;
213 | 
214 |   const memberId = interaction.customId.split('_')[2];
215 |   const guildId = interaction.guild.id;
216 |   const config = serverConfig.get(guildId);
217 |   if (!config || !config.roleId) return;
218 | 
219 |   const member = await interaction.guild.members.fetch(memberId);
220 |   const role = interaction.guild.roles.cache.get(config.roleId);
221 | 
222 |   if (!role) {
223 |     await interaction.reply({ content: '⚠️ Role not found.', ephemeral: true });
224 |     return;
225 |   }
226 | 
227 |   if (interaction.user.id !== memberId) {
228 |     await interaction.reply({ content: '❌ This button is not for you.', ephemeral: true });
229 |     return;
230 |   }
231 | 
232 |   try {
233 |     await member.roles.add(role);
234 |     activeOnboarding.get(guildId)?.delete(memberId);
235 | 
236 |     await interaction.reply({ content: '✅ Role assigned. Welcome aboard!', ephemeral: true });
237 |     console.log(`🎯 Role ${role.name} successfully reassigned to ${member.user.tag}`);
238 |   } catch (error) {
239 |     console.error(`❌ Failed to assign role:`, error);
240 |     await interaction.reply({ content: '❌ Could not assign role. Please check bot permissions.', ephemeral: true });
241 |   }
242 | });
243 | 
244 | // ✅ Start the bot
245 | client.login(token);
