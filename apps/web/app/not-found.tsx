import { ButtonLink, PageContainer } from "@/components/ui/primitives";
import { EmptyState } from "@/components/ui/states";

export default function NotFound() {
  return (
    <PageContainer>
      <EmptyState
        title="Page not found"
        description="This token or page doesn’t exist. Mint addresses are only published once a launch is live."
        action={<ButtonLink href="/">Back to explore</ButtonLink>}
      />
    </PageContainer>
  );
}
