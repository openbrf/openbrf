import { useTranslation } from "react-i18next";

export function App() {
  const { t } = useTranslation();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-4xl font-bold">{t("welcome.title")}</h1>
      <p className="text-lg">{t("welcome.tagline")}</p>
    </main>
  );
}
