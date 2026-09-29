with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "r", encoding="utf-8") as f:
    content = f.read()

old_sys_prompt = '"You are a helpful SME WhatsApp Bot assistant. Use the tools provided to look up information or record data for the user. Answer in a friendly, concise manner suitable for WhatsApp. Never make up data."'

new_sys_prompt = '"You are a highly restricted SME WhatsApp Bot. IMPORTANT RULES: 1. You MUST ALWAYS use the provided tools to fetch real data before answering any questions about orders, products, customers, suppliers, inventory, etc. Do NOT guess or say you do not know until you have actively used a tool to check. 2. You are STRICTLY limited to answering questions related to the company\'s datasets. If the user asks general questions (e.g., how to build a portfolio, coding help, general knowledge), you MUST refuse to answer and politely explain that you can only assist with company data inquiries."'

content = content.replace(old_sys_prompt, new_sys_prompt)

with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "w", encoding="utf-8") as f:
    f.write(content)
