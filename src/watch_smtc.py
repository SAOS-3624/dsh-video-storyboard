"""读 Windows 系统媒体控件（SMTC）里的播放位置。

为什么是系统而不是播放器插件：陪看需要"用户现在看到第几秒"。任何接了 SMTC 的播放器
（VLC / PotPlayer / 电影和电视 / Edge 播网页视频）都会把位置报给系统，插件不必要求用户装
特定的播放器。实测 Edge 播 B 站：`MSEdge | playing | pos=5.9 | dur=68.0 | 标题`。

输出：JSON 数组，每项 {app, status, pos, dur, title}。读不到就输出 []——不报错，
让上层说"读不到你的进度"而不是崩掉。
"""

import asyncio
import json


async def main():
    try:
        from winrt.windows.media.control import (  # noqa: PLC0415
            GlobalSystemMediaTransportControlsSessionManager as Mgr,
        )
    except Exception as e:                       # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"winrt missing: {e}"}, ensure_ascii=False))
        return

    try:
        mgr = await Mgr.request_async()
    except Exception as e:                       # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"SMTC unavailable: {e}"}, ensure_ascii=False))
        return

    out = []
    for s in mgr.get_sessions():
        try:
            tl = s.get_timeline_properties()
            info = s.get_playback_info()
            try:
                title = (await s.try_get_media_properties_async()).title
            except Exception:                    # noqa: BLE001
                title = None
            out.append({
                "app": s.source_app_user_model_id,
                # 4 = paused, 5 = playing（SMTC 枚举）
                "status": int(info.playback_status),
                "pos": round(tl.position.total_seconds(), 2),
                "dur": round(tl.end_time.total_seconds(), 2),
                "title": title,
            })
        except Exception:                        # noqa: BLE001
            continue
    print(json.dumps({"ok": True, "sessions": out}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
