# SME WhatsApp Bot: End-to-End Build Plan

This document outlines the step-by-step architecture and implementation plan for building your SME WhatsApp Bot from scratch using the Meta WhatsApp Cloud API, Python (FastAPI), and the Groq LLM (Llama 3).

## Phase 1: Meta Developer & WhatsApp Setup
1. **Create a Meta Developer App**
   - Go to [developers.facebook.com](https://developers.facebook.com/) and create a new App (Type: Business).
2. **Add the WhatsApp Product**
   - Inside your App dashboard, add the "WhatsApp" product.
   - Meta will provide a "Test Phone Number" to send messages from.
3. **Gather Credentials**
   - Note down your **Temporary Access Token** and **Phone Number ID**.
   - Verify your personal WhatsApp number as a recipient to allow testing.

## Phase 2: Local Environment Setup
1. **Python Virtual Environment**
   - Initialize a virtual environment (`python -m venv venv`) to isolate dependencies.
2. **Install Dependencies**
   - `fastapi` and `uvicorn` for the webhook server.
   - `requests` for making HTTP calls to Meta's Graph API.
   - `pandas` for reading and managing the SME CSV datasets.
   - `groq` and `python-dotenv` for the AI agent and environment variables.
3. **Configure Environment Variables**
   - Create a `.env` file containing your `GROQ_API_KEY`, `META_VERIFY_TOKEN`, `META_WHATSAPP_TOKEN`, and `META_PHONE_NUMBER_ID`.

## Phase 3: The Data Engine (`data_manager.py`)
1. **Load Datasets**
   - Build a mechanism to dynamically read from your CSV files (e.g., `inventory.csv`, `sales_raw.csv`, `expenses.csv`).
2. **Expose Business Logic**
   - Write standard Python functions to perform operations (e.g., `check_inventory(product_id)`, `get_total_sales()`, `add_expense(amount, category)`).
   - Ensure these functions return clean, stringified data so the AI can read the results.

## Phase 4: The AI Agent (`bot.py`)
1. **Define AI Tools**
   - Map your `data_manager.py` functions into JSON schemas that Groq understands (Function Calling).
2. **System Prompt Formulation**
   - Tell the LLM its persona: *"You are an SME WhatsApp Bot. Be friendly, concise, and never make up data."*
3. **Execution Loop**
   - When a user sends a message, send it to Groq. 
   - If Groq requests a tool call, execute the corresponding python function, return the data to Groq, and let it formulate a conversational answer.

## Phase 5: The Webhook Server (`bot.py`)
1. **Webhook Verification (GET `/whatsapp`)**
   - Meta requires a GET endpoint that accepts a `hub.verify_token` and echoes back a `hub.challenge`.
2. **Message Reception (POST `/whatsapp`)**
   - Parse Meta's nested JSON payload to extract the sender's phone number and the text message.
   - Pass the message into the AI Agent.
3. **Message Transmission**
   - Create a helper function using `requests.post` to send the AI's final answer back to Meta's Graph API (`https://graph.facebook.com/v17.0/<PHONE_NUMBER_ID>/messages`).

## Phase 6: Local Testing via Ngrok
1. **Expose Localhost**
   - Run `ngrok http 8000` to create a public HTTPS tunnel to your local FastAPI server.
2. **Configure Meta Webhook**
   - In the Meta Developer Dashboard, set the Webhook URL to your Ngrok URL + `/whatsapp`.
   - Subscribe the webhook to the `messages` event.
3. **End-to-End Test**
   - Send a WhatsApp message to your test number and watch the logs locally!

## Phase 7: Production Deployment
1. **Permanent Access Token**
   - Generate a System User token in Facebook Business Manager so your token doesn't expire every 24 hours.
2. **Cloud Hosting**
   - Deploy your FastAPI app to a cloud provider like Render, Heroku, or AWS EC2.
   - Update your Meta Webhook URL to your permanent cloud server domain.
3. **Database Migration (Optional but Recommended)**
   - Move from CSV files to a proper database like PostgreSQL or Supabase for better concurrent read/write safety.
