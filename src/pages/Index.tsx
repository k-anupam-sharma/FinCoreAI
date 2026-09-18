import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const Index = () => {
  const { t } = useTranslation();

  return (
    <div className="relative flex h-full w-full flex-col bg-gradient-to-b from-whatsapp-dark to-whatsapp p-[32px] max-md:pb-[32px] max-md:pl-[20px] max-md:pr-[20px] max-md:pt-[32px]">
      <div className="text-[26px] text-whatsapp-foreground max-md:text-[22px]">
        {t("common.appName")}
      </div>
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-6 text-center">
        <div className="text-[48px] font-semibold text-whatsapp-foreground max-md:text-[32px]">
          {t("home.hero.title")}
        </div>
        <div className="max-w-xl text-[20px] text-whatsapp-foreground/90 max-md:text-[15px]">
          {t("home.hero.subtitle")}
        </div>
        <Button asChild size="lg" className="mt-2 gap-2 bg-background text-whatsapp-dark hover:bg-background/90">
          <Link to="/assistant">
            <MessageCircle className="h-5 w-5" />
            {t("home.hero.cta")}
          </Link>
        </Button>
        <div className="max-w-md text-xs text-whatsapp-foreground/70">{t("home.hero.note")}</div>
      </div>
    </div>
  );
};

export default Index;
