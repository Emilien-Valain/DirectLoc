import LegalPage, { legalPageMetadata } from "@/components/public/LegalPage";

export const generateMetadata = () => legalPageMetadata("cgv");

export default function Page() {
  return <LegalPage kind="cgv" />;
}
