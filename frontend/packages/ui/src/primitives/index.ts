// primitives layer — public API of the design system's base components.
//
// ARCHITECTURE 修订 v0.2: these are shadcn/ui (Radix + Tailwind v4) sources
// living in `src/components/ui`. Export names stay close to §5.1 so app
// migration is mechanical; renames are listed in MIGRATION.md.

// --- shadcn/ui sources ---------------------------------------------------
export { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogOverlay, AlertDialogPortal, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
export { Avatar, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
export { Badge, badgeVariants } from "@/components/ui/badge";
export { Button, buttonVariants } from "@/components/ui/button";
export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants } from "@/components/ui/button-group";
export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent } from "@/components/ui/card";
export { type CarouselApi, Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from "@/components/ui/carousel";
export { Checkbox } from "@/components/ui/checkbox";
// Collapsible is exported by the patterns layer (styled trigger/content).
export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut, CommandSeparator } from "@/components/ui/command";
export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuCheckboxItem, ContextMenuRadioItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuShortcut, ContextMenuGroup, ContextMenuPortal, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuRadioGroup } from "@/components/ui/context-menu";
export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
export { DropdownMenu, DropdownMenuPortal, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
export { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
export { Input } from "@/components/ui/input";
export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group";
export { Kbd, KbdGroup } from "@/components/ui/kbd";
export { Label } from "@/components/ui/label";
export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverHeader, PopoverTitle, PopoverDescription } from "@/components/ui/popover";
export { Progress } from "@/components/ui/progress";
export { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
export { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
export { Separator } from "@/components/ui/separator";
export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription } from "@/components/ui/sheet";
export { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarRail, SidebarSeparator, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
export { useIsMobile } from "@/hooks/use-mobile";
export { Skeleton } from "@/components/ui/skeleton";
export { Spinner } from "@/components/ui/spinner";
export { Switch } from "@/components/ui/switch";
export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption } from "@/components/ui/table";
export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants } from "@/components/ui/tabs";
export { Textarea } from "@/components/ui/textarea";
export { Toggle, toggleVariants } from "@/components/ui/toggle";
export { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
export { toast } from "sonner";
export { Toaster } from "@/components/ui/sonner";

// --- our wrappers over shadcn --------------------------------------------
export { IconButton, type IconButtonProps } from "./IconButton";
export { SegmentedControl, type SegmentedControlItem, type SegmentedControlProps } from "./SegmentedControl";
export { Combobox, type ComboboxOption, type ComboboxProps } from "./Combobox";
export { ResizablePanels, ResizablePanel, ResizableHandle, type ResizablePanelsProps, type ResizablePanelProps } from "./ResizablePanels";
