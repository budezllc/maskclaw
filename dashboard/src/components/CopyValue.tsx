import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/copyText";

export function CopyValue({
  label,
  value,
  getValue,
  buttonLabel = "Copy",
  "aria-label": ariaLabel,
}: {
  label: string;
  value: string;
  getValue?: () => string;
  buttonLabel?: string;
  "aria-label"?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      onClick={async () => {
        const next = getValue?.() ?? value;
        await copyText(next);
        toast.success(`Copied ${label} ${next}`);
      }}
    >
      <CopyIcon data-icon="inline-start" />
      {buttonLabel}
    </Button>
  );
}
