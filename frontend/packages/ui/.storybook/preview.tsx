import type { Preview } from "@storybook/react-vite";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    controls: { expanded: true },
    backgrounds: { disable: true },
  },
  decorators: [
    withThemeByDataAttribute({
      themes: { Dark: "dark", Light: "light", System: "system" },
      defaultTheme: "Dark",
      attributeName: "data-theme",
    }),
    (Story) => (
      <div className="bg-bg text-fg font-sans text-base antialiased">
        <Story />
      </div>
    ),
  ],
};

export default preview;
