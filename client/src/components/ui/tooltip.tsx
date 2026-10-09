"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/* [사용자 제보 2026-10-09] "액션 칸 기록 툴팁이 폰에서 잠깐 보였다가 화면 밖으로 나간다"
 *   내용을 트리거 바로 옆(같은 DOM 안)에 그렸다. 모바일 하단 패널은 CSS zoom(약 0.67)으로 축소돼 있어,
 *   위치 계산값에 zoom 이 한 번 더 곱해져 칸에서 150px 넘게 떨어진 곳(실측: 칸 443px, 툴팁 251~292px)에 떴다.
 *   → body 로 포털해 축소 밖(화면 좌표 그대로)에서 그린다. 패널(z-80~135)·오버레이보다 위에 오도록 z 도 올린다.
 *   화면 가장자리에선 collisionPadding 만큼 안쪽으로 밀려 들어온다. */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    collisionPadding={collisionPadding}
    className={cn(
      "z-[1000] overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
      className
    )}
    {...props}
  />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
