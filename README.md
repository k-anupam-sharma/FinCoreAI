# FinCore WhatsApp AI Bot

FinCore WhatsApp AI Bot is an intelligent conversational agent built on Supabase Edge Functions and the Meta WhatsApp Cloud API. It interacts with users, handles secure authentication via email OTPs, processes invoices, queries transactions, and performs context-aware financial tasks using AI.

## Architecture

```mermaid
graph TD
    User([User WhatsApp]) -->|Webhook Event| MetaAPI[Meta WhatsApp API]
    MetaAPI -->|POST /whatsapp-webhook| EdgeFunction[Supabase Edge Function]
    EdgeFunction --> SupabaseDB[(Supabase PostgreSQL)]
    EdgeFunction --> Resend[Resend Email API]
    EdgeFunction --> AI[AI Provider]
    
    subgraph Edge Function Logic
        Auth[User Onboarding & OTP]
        OCR[Invoice Processing & OCR]
        Chat[Context-Aware Conversation]
    end
    
    EdgeFunction -.-> Auth
    EdgeFunction -.-> OCR
    EdgeFunction -.-> Chat
```

## User Onboarding Flow

```mermaid
sequenceDiagram
    participant User
    participant WhatsApp
    participant Webhook
    participant DB as Supabase
    participant Resend

    User->>WhatsApp: Sends "Hi"
    WhatsApp->>Webhook: Webhook Event
    Webhook->>DB: Check if user exists (by phone)
    alt User is missing phone
        Webhook->>DB: Start onboarding_email state
        Webhook->>WhatsApp: "Welcome! Enter your email to begin."
        WhatsApp-->>User: Message Received
        User->>WhatsApp: "user@fincore.com"
        WhatsApp->>Webhook: Email payload
        Webhook->>DB: Check if email exists
        Webhook->>Resend: Send 6-digit OTP
        Webhook->>DB: Save OTP Hash & move to onboarding_otp
        Webhook->>WhatsApp: "Enter your 6-digit OTP"
        User->>WhatsApp: "123456"
        WhatsApp->>Webhook: OTP received
        Webhook->>DB: Verify OTP hash
        Webhook->>DB: Update user phone & link account
        Webhook->>WhatsApp: "Account verified! How can I help?"
    else User exists
        Webhook->>AI: Send conversation history
        AI-->>Webhook: AI Response
        Webhook->>WhatsApp: AI Response Message
    end
```

## Setup & Deployment

1. Set up a Supabase Project.
2. Provide the following environment variables in your `.env` file:
   - `WHATSAPP_VERIFY_TOKEN`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET`
   - `RESEND_API_KEY`
   - `ENTER_AI_API_KEY`
3. Deploy the Edge Function:
   ```bash
   npx supabase secrets set --env-file .env
   npx supabase functions deploy whatsapp-webhook
   ```
4. Push database migrations and seed data:
   ```bash
   npx supabase db push
   ```
5. Configure the Meta App Dashboard Webhook to point to the Supabase Edge Function URL.

## Database Seeding & Mock Data Cleanup

The raw mock datasets provided for this project had several structural inconsistencies (e.g., mismatched foreign keys with `-D` tags, empty numeric and date fields, missing company IDs, and extra columns). 

Robust automated Node.js cleanup scripts (`scripts/data-cleanup/`) were written and executed to sanitize this data perfectly:
- Stripped unnecessary trailing strings and `-D` suffixes specifically for foreign keys to match the `companies` table.
- Filled in completely blank numeric and date fields with safe database defaults (e.g., `0.0` or `2024-01-01`) to prevent PostgreSQL syntax errors.
- Preemptively nullified or corrected broken foreign key references (such as mock users that do not exist in the `users` table).
- Automatically mapped all missing `company_id` values to `COMP-01`.

The fully sanitized, database-ready CSV files are located in the `docs/clean-datasets` folder. These files can be safely imported directly into their respective tables via the Supabase Dashboard Table Editor with zero constraint errors.
