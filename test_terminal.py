import os
from dotenv import load_dotenv
from bot import process_message

# Load environment variables
load_dotenv()

# Check for API key
if not os.environ.get("NVIDIA_API_KEY") or os.environ.get("NVIDIA_API_KEY") == "your_nvidia_api_key_here":
    print("❌ ERROR: You haven't set your NVIDIA_API_KEY in the .env file yet!")
    print("Please add your actual Nvidia API key to the .env file before testing.")
    exit(1)

print("="*50)
print("🤖 SME Bot Terminal Tester")
print("Type 'quit' or 'exit' to stop.")
print("="*50)

while True:
    try:
        user_input = input("\nYou: ")
        if user_input.lower() in ['quit', 'exit']:
            print("Goodbye!")
            break
            
        if not user_input.strip():
            continue
            
        print("Bot is thinking...")
        # This calls the exact same AI logic your WhatsApp bot uses!
        reply = process_message(user_input)
        
        print(f"\nBot: {reply}")
        
    except KeyboardInterrupt:
        print("\nGoodbye!")
        break
    except Exception as e:
        print(f"\nError: {e}")
