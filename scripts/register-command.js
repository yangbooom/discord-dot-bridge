// Explicit operator action only. Does not bulk-overwrite other application commands.
const { DISCORD_APPLICATION_ID: app, DISCORD_GUILD_ID: guild, DISCORD_BOT_TOKEN: token } = process.env;
if (!/^\d{17,20}$/.test(app || '') || !/^\d{17,20}$/.test(guild || '') || !token) throw new Error('Set application ID, guild ID and bot token securely in environment.');
const response = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
  method: 'POST', signal: AbortSignal.timeout(10000),
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'dot', description: '승인된 도우미에게 작업 요청 (답변은 채널에 공개)', type: 1,
    options: [{ name: 'task', description: '민감한 정보 없이 작업 내용을 입력하세요', type: 3, required: true, min_length: 1, max_length: 1700 }] })
});
if (!response.ok) throw new Error(`Command registration failed: HTTP ${response.status}`);
const command = await response.json();
console.log(JSON.stringify({ commandId: command.id, name: command.name }));
