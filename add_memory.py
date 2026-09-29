import re

with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "r", encoding="utf-8") as f:
    content = f.read()

# Add conversations dict and update process_message definition
old_def = """def process_message(message: str) -> str:
    messages = [
        {"role": "system", "content": "You are a helpful SME WhatsApp Bot assistant. Use the tools provided to look up information or record data for the user. Answer in a friendly, concise manner suitable for WhatsApp. Never make up data."},
        {"role": "user", "content": message}
    ]"""

new_def = """# In-memory conversational context (Phone Number -> List of messages)
conversations = {}

def process_message(message: str, user_id: str = "default") -> str:
    # Initialize history for this user if it doesn't exist
    if user_id not in conversations:
        conversations[user_id] = [
            {"role": "system", "content": "You are a helpful SME WhatsApp Bot assistant. Use the tools provided to look up information or record data for the user. Answer in a friendly, concise manner suitable for WhatsApp. Never make up data."}
        ]
    
    # Append the new user message to their specific history
    conversations[user_id].append({"role": "user", "content": message})
    
    # Keep only the last 10 messages (plus the system prompt) to avoid hitting token limits
    if len(conversations[user_id]) > 11:
        conversations[user_id] = [conversations[user_id][0]] + conversations[user_id][-10:]
        
    messages = conversations[user_id].copy()"""

content = content.replace(old_def, new_def)

# We need to save the final response back to the conversation history!
old_ret_1 = """            return second_response.choices[0].message.content
            
        return response_message.content"""

new_ret_1 = """            final_reply = second_response.choices[0].message.content
            conversations[user_id].append({"role": "assistant", "content": final_reply})
            return final_reply
            
        final_reply = response_message.content
        conversations[user_id].append({"role": "assistant", "content": final_reply})
        return final_reply"""

content = content.replace(old_ret_1, new_ret_1)

# Now update the webhook endpoint to pass the phone number!
old_webhook = """            if message_body:
                # Process the message with AI
                reply = process_message(message_body)"""
new_webhook = """            if message_body:
                # Process the message with AI (pass the user's phone number for memory!)
                reply = process_message(message_body, user_id=from_number)"""
                
content = content.replace(old_webhook, new_webhook)

with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\bot.py", "w", encoding="utf-8") as f:
    f.write(content)
