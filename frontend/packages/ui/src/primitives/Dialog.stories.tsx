import type { StoryObj } from "@storybook/react-vite";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./index";

const meta = {
  title: "Primitives/Dialog",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

export const EditAgent: Story = {
  // Open by default so the dialog's own layout is visible in docs and in the
  // screenshot pass (a trigger-only render captures an empty page).
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="primary">Edit agent</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Juno</DialogTitle>
          <DialogDescription>
            Changes take effect on the next run.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Juno triages your inbox every weekday at 9:00.
        </p>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button variant="primary">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const ConfirmDelete: Story = {
  render: () => (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="danger">Delete routine</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this routine?</AlertDialogTitle>
          <AlertDialogDescription>
            Juno will stop running the morning inbox triage. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction>Delete routine</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
};
