import bot

bot.conversations["test_user"] = []
print("TESTING bot.process_message")
# monkey patch client to trace
original_create = bot.client.chat.completions.create
def patched_create(*args, **kwargs):
    print("\n[API CALL] messages:")
    for m in kwargs.get("messages", []):
        print(f"  {type(m)}: {m}")
    res = original_create(*args, **kwargs)
    print(f"[API RESPONSE] {res.choices[0].message}")
    return res

bot.client.chat.completions.create = patched_create

bot.process_message("What is the status of invoice GST-3525-26?", "test_user")
