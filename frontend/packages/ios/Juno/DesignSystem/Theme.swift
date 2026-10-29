import SwiftUI

/// Semantic tokens from packages/ui theme/tokens.css (light / dark blocks) + docs/design/VISUAL.md:
/// neutral surfaces, colour only on agent avatars and status, no blue anywhere.
enum Theme {
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    private static func dynamicAlpha(light: UInt32, lightAlpha: CGFloat, dark: UInt32, darkAlpha: CGFloat) -> Color {
        Color(uiColor: UIColor {
            $0.userInterfaceStyle == .dark ? UIColor(hex: dark).withAlphaComponent(darkAlpha) : UIColor(hex: light).withAlphaComponent(lightAlpha)
        })
    }

    /// --background
    static let canvas = dynamic(light: 0xfcfcfc, dark: 0x0e0e0e)
    /// --panel-background
    static let panel = dynamic(light: 0xf9f9f9, dark: 0x171717)
    /// --card
    static let card = dynamic(light: 0xffffff, dark: 0x212121)
    /// --muted / --secondary
    static let muted = dynamic(light: 0xf4f4f4, dark: 0x212121)
    /// --composer-background
    static let composer = dynamic(light: 0xffffff, dark: 0x212121)
    /// --composer-shadow's hairline: rgb(0 0 0 / .04) ring in light, inset white 20% in dark
    static let composerEdge = dynamicAlpha(light: 0x000000, lightAlpha: 0.04, dark: 0xffffff, darkAlpha: 0.2)
    /// Idle send button: --accent (= --interactive-hover)
    static let composerIdle = dynamic(light: 0xf1f1f1, dark: 0x2f2f2f)
    /// --interactive-selected
    static let selected = dynamic(light: 0xededed, dark: 0x3a3a3a)
    /// --foreground
    static let fg = dynamic(light: 0x0d0d0d, dark: 0xededed)
    /// --muted-foreground
    static let fgMuted = dynamic(light: 0x5d5d5d, dark: 0xcdcdcd)
    /// --border
    static let border = dynamicAlpha(light: 0x141414, lightAlpha: 0.15, dark: 0xfcfcfc, darkAlpha: 0.15)
    /// --primary (neutral pill: black in light, white in dark)
    static let primary = dynamic(light: 0x070707, dark: 0xfafafa)
    static let primaryFg = dynamic(light: 0xffffff, dark: 0x070707)
    /// Chat bubbles: --bubble-agent / --bubble-user
    static let bubbleAgent = dynamic(light: 0xeeeeee, dark: 0x333333)
    static let bubbleAgentFg = dynamic(light: 0x141414, dark: 0xfcfcfc)
    static let bubbleUser = dynamic(light: 0x070707, dark: 0xf4efe6)
    static let bubbleUserFg = dynamic(light: 0xfcfcfc, dark: 0x141414)

    /// --bg-subtle
    static let bgSubtle = dynamic(light: 0xf4f4f4, dark: 0x171717)
    /// --fg-subtle
    static let fgSubtle = dynamic(light: 0x8f8f8f, dark: 0xafafaf)
    /// --interactive-hover (ghost hover, idle send, segmented track in dark)
    static let hover = dynamic(light: 0xf1f1f1, dark: 0x2f2f2f)
    /// --input-background
    static let inputBg = dynamic(light: 0xfcfcfc, dark: 0x2f2f2f)

    /// Request cards (docs mockups "pass 2"): white / #181818 surface, and the tiles inside it #f4f4f4 / #242424.
    static let requestCard = dynamic(light: 0xffffff, dark: 0x181818)
    static let tile = dynamic(light: 0xf4f4f4, dark: 0x242424)

    /// The Today glow: soft pink, purple and blue (the characters' tints, web CHARACTER_TINT pink / purple / blue).
    static let glow: [Color] = [0xf08bb4, 0x9b7bf0, 0x5b8def].map { Color(uiColor: UIColor(hex: UInt32($0))) }

    static let success = Color(uiColor: UIColor(hex: UInt32(0x00c972)))
    static let warning = Color(uiColor: UIColor(hex: UInt32(0xff9800)))
    static let danger = Color(uiColor: UIColor(hex: UInt32(0xff263c)))
}

// MARK: - Scale (tokens.css): every size in the content views comes from here

enum Radius {
    static let xs: CGFloat = 4, sm: CGFloat = 8, md: CGFloat = 10, lg: CGFloat = 14, xl: CGFloat = 16, xxl: CGFloat = 18
    /// --composer-radius; 24 once the field has grown past one row
    static let composer: CGFloat = 26, composerGrown: CGFloat = 24
    /// components/computer/surface.ts
    static let screen: CGFloat = 24, popover: CGFloat = 14
    /// Request card (28), its tiles (20) and the preview picture (16)
    static let card: CGFloat = 28, tile: CGFloat = 20, preview: CGFloat = 16
}

/// Text scale (size / line height): 2xs 11/15, xs 12/16, sm 13/18, base 14/20, md 15/22, lg 17/24, xl 22/30, 2xl 26/34.
enum TextSize {
    case xxs, xs, sm, base, md, lg, xl, xxl
    var size: CGFloat { switch self { case .xxs: 11; case .xs: 12; case .sm: 13; case .base: 14; case .md: 15; case .lg: 17; case .xl: 22; case .xxl: 26 } }
    var lineHeight: CGFloat { switch self { case .xxs: 15; case .xs: 16; case .sm: 18; case .base: 20; case .md: 22; case .lg: 24; case .xl: 30; case .xxl: 34 } }
}

/// AgentAvatar sizes used by the web: xs 20, sm 24, md 32, lg 40, header 56, card 112 (+ 18 for group author rows).
enum AvatarSize {
    static let author: CGFloat = 18, xs: CGFloat = 20, sm: CGFloat = 24, md: CGFloat = 32, lg: CGFloat = 40, header: CGFloat = 56, profile: CGFloat = 90, card: CGFloat = 112
    static let chatHeader: CGFloat = 88
}

extension View {
    /// Web text token: size + line height (+ weight).
    func text(_ t: TextSize, _ weight: Font.Weight = .regular) -> some View {
        font(.system(size: t.size, weight: weight)).lineSpacing(t.lineHeight - t.size * 1.2)
    }
}

/// ui/components/ui/button.tsx: rounded-full, 13px medium. Sizes xs 24 / sm 32 / default 36; variants primary / secondary / ghost.
struct WebButton: ButtonStyle {
    enum Variant { case primary, secondary, ghost }
    enum Size { case xs, sm, regular, large, hero }
    var variant: Variant = .primary
    var size: Size = .sm
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let height: CGFloat = switch size { case .xs: 24; case .sm: 32; case .regular: 36; case .large: 40; case .hero: 52 }
        let padding: CGFloat = switch size { case .xs: 10; case .sm: 12; case .regular: 16; case .large: 24; case .hero: 24 }
        configuration.label
            .text(size == .xs ? .xs : size == .hero ? .md : .sm, size == .hero ? .semibold : .medium)
            .lineLimit(1)
            .foregroundStyle(variant == .primary ? Theme.primaryFg : Theme.fg)
            .padding(.horizontal, padding)
            .frame(height: height)
            .background(background(pressed: configuration.isPressed), in: .capsule)
            .opacity(enabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .primary: Theme.primary.opacity(pressed ? 0.85 : 1)
        case .secondary: pressed ? Theme.hover : Theme.muted
        case .ghost: pressed ? Theme.hover : .clear
        }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
}

// MARK: - Agent accent (OpenAI dots: the chat takes on the agent's colour)

extension EnvironmentValues {
    /// The open chat's agent colour (its avatar colour); nil in group chats and outside a chat.
    @Entry var agentAccent: Color? = nil
}

/// Black or white text, whichever reads better on `color` (WCAG relative luminance).
func onColor(_ color: Color) -> Color {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
    func lin(_ c: CGFloat) -> CGFloat { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    let l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    return l > 0.4 ? Color(uiColor: UIColor(hex: UInt32(0x141414))) : .white
}

extension View {
    /// A text field's surface, as the web's inputs: solid input fill with a hairline border (owner 2026-10-13:
    /// no Liquid Glass on fields), 17pt text, 14pt corners.
    func inputField() -> some View {
        text(.lg)
            .padding(.horizontal, 16).frame(minHeight: 52)
            .background(Theme.inputBg, in: .rect(cornerRadius: Radius.lg))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Theme.border, lineWidth: 1))
    }

    /// A native List/Form on the web palette (owner 2026-10-13: not iOS's grouped grey): the canvas behind it,
    /// with rows on `Theme.muted` set by the caller (`.listRowBackground(Theme.muted)`).
    func webGrouped() -> some View {
        scrollContentBackground(.hidden).background(Theme.canvas)
    }
}

