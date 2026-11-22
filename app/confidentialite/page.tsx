import LegalPage, { legalPageMetadata } from "@/components/public/LegalPage";

export const generateMetadata = () => legalPageMetadata("privacy");

export default function Page() {
  return <LegalPage kind="privacy" />;
}
