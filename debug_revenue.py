import bot
import os
from dotenv import load_dotenv

load_dotenv()
bot.conversations["test_user"] = []
print("TESTING bot.process_message")

reply = bot.process_message("If I sell 50 more Global Desi Palazzo sets next month, how much extra revenue will that generate based on its current price?", "test_user")
print("\n--- FINAL REPLY ---")
print(reply)
