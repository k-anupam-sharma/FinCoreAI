import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ChatShell } from "@/components/whatsapp/ChatShell";

const Assistant = () => {
  const { t } = useTranslation();

  return (
    <div className="flex h-full w-full flex-col items-center gap-4 bg-gradient-to-b from-whatsapp-dark/10 to-background p-4 md:p-8">
      <div className="flex w-full max-w-md flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <span className="text-xs text-muted-foreground sm:text-right">{t("home.hero.note")}</span>
      </div>
      <div className="flex w-full flex-1 items-center justify-center">
        <ChatShell />
      </div>
    </div>
  );
};

export default Assistant;
