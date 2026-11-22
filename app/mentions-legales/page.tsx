import LegalPage, { legalPageMetadata } from "@/components/public/LegalPage";

export const generateMetadata = () => legalPageMetadata("legalNotice");

export default function Page() {
  return <LegalPage kind="legalNotice" />;
}
