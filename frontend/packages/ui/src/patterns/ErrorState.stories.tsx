import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertTriangle, Wifi } from "lucide-react";
import { ErrorState } from "./ErrorState";

const meta = {
  title: "Patterns/ErrorState",
  component: ErrorState,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof ErrorState>;

export const Default: Story = {
  args: {
    title: "Something went wrong",
    description: "We encountered an unexpected error. Please try again.",
    onRetry: () => console.log("Retry clicked"),
  },
};

export const CustomTitle: Story = {
  args: {
    title: "Failed to load agents",
    description: "Unable to fetch the list of agents. Check your connection and try again.",
    onRetry: () => console.log("Retry clicked"),
    retryLabel: "Reload",
  },
};

export const ConnectionError: Story = {
  args: {
    icon: <Wifi />,
    title: "Connection lost",
    description: "Please check your internet connection and try again.",
    onRetry: () => console.log("Retry clicked"),
  },
};

export const WithoutRetry: Story = {
  args: {
    title: "Forbidden",
    description: "You don't have permission to access this resource.",
  },
};

export const ComplexError: Story = {
  args: {
    icon: <AlertTriangle />,
    title: "Operation failed",
    description:
      "The server returned an error while processing your request. If this persists, please contact support.",
    onRetry: () => console.log("Retry clicked"),
    retryLabel: "Try again",
  },
};
