import { useCallback, useEffect, useRef, useState } from "react";
import { handleMessage, initialContext, type ChatContext } from "@/lib/fincore/conversation";

export interface ChatMessage {
  id: string;
  sender: "user" | "bot";
  text: string;
  quickReplies?: string[];
  timestamp: number;
}

const MESSAGES_KEY = "fincore_chat_messages_v1";
const CONTEXT_KEY = "fincore_chat_context_v1";

function loadMessages(): ChatMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadContext(): ChatContext {
  if (typeof localStorage === "undefined") return initialContext();
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw ? JSON.parse(raw) : initialContext();
  } catch {
    return initialContext();
  }
}

export function useFinCoreChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages());
  const contextRef = useRef<ChatContext>(loadContext());

  useEffect(() => {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  }, [messages]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), sender: "user", text: trimmed, timestamp: Date.now() };
    const result = handleMessage(contextRef.current, trimmed);
    contextRef.current = result.context;
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(result.context));

    const botMessages: ChatMessage[] = result.replies.map((r) => ({
      id: crypto.randomUUID(),
      sender: "bot",
      text: r.text,
      quickReplies: r.quickReplies,
      timestamp: Date.now(),
    }));

    setMessages((prev) => [...prev, userMessage, ...botMessages]);
  }, []);

  const restartDemo = useCallback(() => {
    localStorage.removeItem(MESSAGES_KEY);
    localStorage.removeItem(CONTEXT_KEY);
    localStorage.removeItem("fincore_device_phone_v1");
    localStorage.removeItem("fincore_demo_overlay_v1");
    contextRef.current = initialContext();
    setMessages([]);
  }, []);

  return { messages, sendMessage, restartDemo };
}
