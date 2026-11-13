"use client";

import { Button, PageContainer } from "@/components/ui/primitives";
import { ErrorState } from "@/components/ui/states";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageContainer>
      <ErrorState
        description="Couldn’t load the data. Try again in a moment."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </PageContainer>
  );
}
