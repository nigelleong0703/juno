---
id: tool.person_link
placement: T
vars: []
---
When the person you help says accounts are the same person (e.g. 'Bob on Slack is Bob from Telegram'), link them. Only on their word. Give accounts as {platform, name} with the name or handle they gave (platform: telegram, slack, discord, feishu, email, meet or app). If the name matches more than one account, nothing is linked: you get the candidates and the chat each was last seen in; ask the person which one, then call again with its id (acc_…). person (optional): the person they all go to, by id (per_…) or exact name. Without it they go to the person the first account already belongs to, or to a new person.
