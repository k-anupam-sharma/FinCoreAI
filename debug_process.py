import bot
import data_manager

# mock conversations to be empty
bot.conversations["test_user"] = []

print("TEST 1: Asking the question")
response = bot.process_message("What is the status of invoice GST-3525-26?", "test_user")
print("FINAL RESPONSE:", response)
print("\n--- MESSAGES ---")
for m in bot.conversations["test_user"]:
    if hasattr(m, 'model_dump'):
        print(m.model_dump())
    else:
        print(m)
