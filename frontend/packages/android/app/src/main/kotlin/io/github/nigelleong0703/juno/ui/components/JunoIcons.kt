package io.github.nigelleong0703.juno.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.*

/**
 * Lucide stand-ins for the SF Symbols the iPhone app uses (names in the comments are the SF Symbol).
 * Use these instead of `Icons.*`; add a line here when a new screen needs a symbol.
 */
object JunoIcons {
    // Tabs and shell
    val Sun: ImageVector = Lucide.Sun // sun.max
    val Chat: ImageVector = Lucide.MessageSquare // bubble.left
    val Feed: ImageVector = Lucide.Newspaper // newspaper
    val Ideas: ImageVector = Lucide.Lightbulb // lightbulb
    val Goals: ImageVector = Lucide.SquareCheck // checkmark.square
    val Library: ImageVector = Lucide.Folder // folder


    val Plugins: ImageVector = Lucide.Puzzle // puzzlepiece.extension
    val Search: ImageVector = Lucide.Search // magnifyingglass
    val Compose: ImageVector = Lucide.SquarePen // square.and.pencil
    val Menu: ImageVector = Lucide.Menu // line.3.horizontal
    val Settings: ImageVector = Lucide.Settings // gearshape
    val Computer: ImageVector = Lucide.Monitor // macwindow / desktop
    val Mic: ImageVector = Lucide.Mic // mic
    val Waveform: ImageVector = Lucide.AudioWaveform // waveform
    val Stop: ImageVector = Lucide.CircleStop // stop.circle
    val Pause: ImageVector = Lucide.Pause // pause.fill
    val Play: ImageVector = Lucide.Play // play.fill

    // Navigation and chevrons
    val ChevronLeft: ImageVector = Lucide.ChevronLeft // chevron.left
    val ChevronRight: ImageVector = Lucide.ChevronRight // chevron.right
    val ChevronDown: ImageVector = Lucide.ChevronDown // chevron.down
    val ChevronsUpDown: ImageVector = Lucide.ChevronsUpDown // chevron.up.chevron.down
    val ArrowUp: ImageVector = Lucide.ArrowUp // arrow.up (send)
    val ArrowRight: ImageVector = Lucide.ArrowRight // arrow.right
    val ArrowUpRight: ImageVector = Lucide.ArrowUpRight // arrow.up.right
    val Reply: ImageVector = Lucide.CornerUpLeft // arrow.turn.up.left
    val Share: ImageVector = Lucide.Share // arrowshape.turn.up.right
    val Download: ImageVector = Lucide.Download // arrow.down.circle
    val Maximize: ImageVector = Lucide.Maximize2 // arrow.up.left.and.arrow.down.right
    val Refresh: ImageVector = Lucide.RefreshCw // arrow.triangle.2.circlepath

    // Actions
    val Plus: ImageVector = Lucide.Plus // plus
    val Close: ImageVector = Lucide.X // xmark
    val Check: ImageVector = Lucide.Check // checkmark
    val Pin: ImageVector = Lucide.Pin // pin.fill
    val Bell: ImageVector = Lucide.Bell
    val BellOff: ImageVector = Lucide.BellOff // bell.slash.fill
    val Trash: ImageVector = Lucide.Trash2
    val Copy: ImageVector = Lucide.Copy
    val Paste: ImageVector = Lucide.ClipboardPaste // doc.on.clipboard
    val Edit: ImageVector = Lucide.Pencil // pencil
    val Eye: ImageVector = Lucide.Eye // eye
    val EyeOff: ImageVector = Lucide.EyeOff // eye.slash
    val Link: ImageVector = Lucide.Link // link
    val ThumbDown: ImageVector = Lucide.ThumbsDown
    val Ellipsis: ImageVector = Lucide.Ellipsis // ellipsis
    val EllipsisVertical: ImageVector = Lucide.EllipsisVertical
    val Minus: ImageVector = Lucide.Minus
    val Keyboard: ImageVector = Lucide.Keyboard // keyboard

    // Status
    val Circle: ImageVector = Lucide.Circle // circle
    val CheckCircle: ImageVector = Lucide.CircleCheck // checkmark.circle.fill
    val CheckSquare: ImageVector = Lucide.SquareCheck // checkmark.square.fill
    val Square: ImageVector = Lucide.Square // square
    val Alert: ImageVector = Lucide.CircleAlert // exclamationmark.circle
    val Warning: ImageVector = Lucide.TriangleAlert // exclamationmark.triangle.fill
    val Info: ImageVector = Lucide.Info // info.circle
    val Help: ImageVector = Lucide.CircleHelp
    val Hourglass: ImageVector = Lucide.Hourglass // hourglass
    val Shield: ImageVector = Lucide.ShieldCheck // checkmark.shield
    val ShieldAlert: ImageVector = Lucide.ShieldAlert
    val Lock: ImageVector = Lucide.Lock // lock

    // Content
    val Photo: ImageVector = Lucide.Image // photo
    val File: ImageVector = Lucide.FileText // doc
    val Table: ImageVector = Lucide.Table
    val Terminal: ImageVector = Lucide.Terminal // terminal
    val Newspaper: ImageVector = Lucide.Newspaper // newspaper
    val Forum: ImageVector = Lucide.MessagesSquare // bubble.left.and.bubble.right
    val Sparkles: ImageVector = Lucide.Sparkles // sparkles
    val Zap: ImageVector = Lucide.Zap // bolt
    val Megaphone: ImageVector = Lucide.Megaphone
    val Brain: ImageVector = Lucide.Brain
    val Cpu: ImageVector = Lucide.Cpu
    val Usage: ImageVector = Lucide.ChartColumn // chart.bar
    val Key: ImageVector = Lucide.KeyRound // key
    val Globe: ImageVector = Lucide.Globe // globe
    val Video: ImageVector = Lucide.Video // video
    val Music: ImageVector = Lucide.Music
    val Tv: ImageVector = Lucide.Tv
    val Heart: ImageVector = Lucide.Heart
    val Fingerprint: ImageVector = Lucide.Fingerprint
    val Contrast: ImageVector = Lucide.Contrast
    val Moon: ImageVector = Lucide.Moon
    val Pointer: ImageVector = Lucide.MousePointerClick
    val Mouse: ImageVector = Lucide.MousePointer2
    val Hand: ImageVector = Lucide.Hand
    val Grid: ImageVector = Lucide.LayoutGrid // square.grid.2x2
    val History: ImageVector = Lucide.History
    val Target: ImageVector = Lucide.Target
    val Clock: ImageVector = Lucide.Clock
    val Calendar: ImageVector = Lucide.Calendar
    val CalendarCheck: ImageVector = Lucide.CalendarCheck
    val CalendarClock: ImageVector = Lucide.CalendarClock // calendar.badge.clock
    val Quote: ImageVector = Lucide.Quote
    val List: ImageVector = Lucide.List
    val Checklist: ImageVector = Lucide.ListChecks
    val Camera: ImageVector = Lucide.Camera
    val Mail: ImageVector = Lucide.Mail
    val CreditCard: ImageVector = Lucide.CreditCard
    val ShoppingCart: ImageVector = Lucide.ShoppingCart
    val Book: ImageVector = Lucide.BookOpen
    val Map: ImageVector = Lucide.Map

    // People
    val User: ImageVector = Lucide.User // person
    val Users: ImageVector = Lucide.Users // person.3.fill
    val UserPlus: ImageVector = Lucide.UserPlus
    val Profile: ImageVector = Lucide.CircleUserRound // person.crop.circle
    val AccountBox: ImageVector = Lucide.SquareUserRound
    val ContactPage: ImageVector = Lucide.ContactRound
}
