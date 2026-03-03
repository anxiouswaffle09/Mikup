mod data;
mod root_view;
mod state;
mod transcript_view;
mod waveform_view;

use gpui::*;
use root_view::RootView;

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_window, cx| cx.new(|cx| RootView::new(cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}
