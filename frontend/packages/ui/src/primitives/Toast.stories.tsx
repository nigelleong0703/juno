import type { StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Button, toast } from "./index";
import { Toaster } from "@/components/ui/sonner";

const meta = {
  title: "Primitives/Toast",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

export const Sonner: Story = {
  render: () => <SonnerDemo />,
};

function SonnerDemo() {
  // Fire one toast on mount so the story (and its screenshot) shows a toast
  // without requiring a click; the buttons below raise the other variants.
  useEffect(() => {
    toast.success("Juno finished the inbox triage");
  }, []);
  return (
    <div className="flex items-center gap-3">
      <Toaster />
      <Button variant="outline" onClick={() => toast("Routine saved")}>
        Default
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.success("Juno finished the inbox triage")}
      >
        Success
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error("Could not reach the mail server")}
      >
        Error
      </Button>
    </div>
  );
}
