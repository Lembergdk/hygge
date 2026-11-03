import SwiftUI
import UIKit

/// Real pointer/keyboard input into the streamed browser; no proxy form fields.
struct RemoteBrowserCanvas: UIViewRepresentable {
    var session: LiveBrowserSession
    var image: UIImage?
    var viewport: CGSize
    var pointer: CGPoint
    var keyboardVisible: Bool
    var interactive = false
    var revealControls: (() -> Void)?
    func makeUIView(context: Context) -> RemotePageView { RemotePageView() }
    func updateUIView(_ view: RemotePageView, context: Context) {
        view.session = session
        view.interactive = interactive && session.ownsControl && session.connected
        view.revealControls = revealControls
        view.render()
    }
}

final class RemotePageView: UIView, UIKeyInput, UIGestureRecognizerDelegate {
    var session: LiveBrowserSession?
    var interactive = false
    var revealControls: (() -> Void)?
    private let picture = UIImageView()
    private let cursor = UIImageView(image: UIImage(systemName: "cursorarrow"))
    private var panStart = CGPoint.zero
    private var dragging = false
    private var zoom: CGFloat = 1
    private var precisionPoint = CGPoint(x: 0.5, y: 0.5)
    var hasText: Bool { true }
    override var canBecomeFirstResponder: Bool { interactive }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var keyboardType: UIKeyboardType = .default
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        picture.contentMode = .scaleAspectFit
        addSubview(picture)
        cursor.tintColor = .black
        cursor.layer.shadowColor = UIColor.white.cgColor
        cursor.layer.shadowOpacity = 1; cursor.layer.shadowRadius = 1
        addSubview(cursor)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tap(_:)))
        addGestureRecognizer(tap)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.delegate = self; addGestureRecognizer(pan)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(hold(_:)))
        hold.minimumPressDuration = 0.35; hold.delegate = self; addGestureRecognizer(hold)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        addGestureRecognizer(pinch)
        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hover(_:)))
        addGestureRecognizer(hover)
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edge(_:)))
        edge.edges = .right; addGestureRecognizer(edge)
        pan.require(toFail: edge)
        accessibilityLabel = "Live browser page"
        accessibilityHint = "Use the keyboard button to type. Swipe inward from the right edge for fullscreen controls."
        isAccessibilityElement = true
        accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Show browser controls", target: self, selector: #selector(showControls))]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var inputAccessoryView: UIView? {
        let bar = UIToolbar()
        bar.sizeToFit()
        bar.items = [
            UIBarButtonItem(title: "Tab", style: .plain, target: self, action: #selector(tabKey)),
            UIBarButtonItem(image: UIImage(systemName: "arrow.left"), style: .plain, target: self, action: #selector(leftKey)),
            UIBarButtonItem(image: UIImage(systemName: "arrow.right"), style: .plain, target: self, action: #selector(rightKey)),
            UIBarButtonItem(systemItem: .flexibleSpace),
            UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(hideKeyboard))
        ]
        bar.tintColor = UIColor(HyggeTheme.sageDeep)
        bar.barTintColor = UIColor(HyggeTheme.paper)
        return bar
    }
    func render() {
        picture.image = session?.image
        if let point = session?.pointer { precisionPoint = point }
        cursor.isHidden = session?.image == nil || session?.connected != true
        if session?.keyboardVisible == true && interactive { if !isFirstResponder { becomeFirstResponder() } }
        else if isFirstResponder { resignFirstResponder() }
        setNeedsLayout()
    }
    private var contentRect: CGRect {
        let size = session?.image?.size ?? session?.viewport ?? CGSize(width: 1365, height: 900)
        let scale = min(bounds.width / size.width, bounds.height / size.height) * zoom
        return CGRect(x: (bounds.width - size.width * scale) / 2, y: (bounds.height - size.height * scale) / 2,
                      width: size.width * scale, height: size.height * scale)
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = contentRect
        cursor.frame = CGRect(x: contentRect.minX + precisionPoint.x * contentRect.width,
                              y: contentRect.minY + precisionPoint.y * contentRect.height, width: 18, height: 24)
    }
    private func location(_ point: CGPoint) -> CGPoint? {
        let rect = contentRect
        guard rect.width > 0, rect.height > 0, rect.contains(point) else { return nil }
        return CGPoint(x: (point.x - rect.minX) / rect.width, y: (point.y - rect.minY) / rect.height)
    }
    private func pointer(_ phase: String, _ point: CGPoint) {
        guard interactive else { return }
        precisionPoint = point
        session?.input(["type": "pointer", "phase": phase, "x": point.x, "y": point.y])
        setNeedsLayout()
    }
    @objc private func tap(_ gesture: UITapGestureRecognizer) {
        guard interactive else { return }
        if session?.precisionPointer == true { pointer("click", precisionPoint) }
        else if let point = location(gesture.location(in: self)) { pointer("click", point) }
    }
    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        guard interactive else { return }
        let translation = gesture.translation(in: self)
        if gesture.state == .began { panStart = .zero }
        let delta = CGPoint(x: translation.x - panStart.x, y: translation.y - panStart.y)
        panStart = translation
        if dragging, let point = location(gesture.location(in: self)) { pointer("move", point) }
        else if session?.precisionPointer == true {
            let point = CGPoint(x: min(1, max(0, precisionPoint.x + delta.x / contentRect.width)), y: min(1, max(0, precisionPoint.y + delta.y / contentRect.height)))
            pointer("move", point)
        } else {
            let scale = (session?.viewport.width ?? 1365) / max(1, contentRect.width)
            session?.input(["type": "scroll", "dx": max(-3000, min(3000, -delta.x * scale)), "dy": max(-3000, min(3000, -delta.y * scale))])
        }
    }
    @objc private func hold(_ gesture: UILongPressGestureRecognizer) {
        guard interactive else { return }
        let point = session?.precisionPointer == true ? precisionPoint : location(gesture.location(in: self))
        guard let point else { return }
        switch gesture.state {
        case .began: dragging = true; pointer("down", point)
        case .changed: pointer("move", point)
        case .ended, .cancelled, .failed: pointer("up", point); dragging = false
        default: break
        }
    }
    @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
        zoom = min(3, max(1, zoom * gesture.scale)); gesture.scale = 1; setNeedsLayout()
    }
    @objc private func hover(_ gesture: UIHoverGestureRecognizer) {
        if let point = location(gesture.location(in: self)) { pointer("move", point) }
    }
    @objc private func edge(_ gesture: UIScreenEdgePanGestureRecognizer) { if gesture.state == .recognized { revealControls?() } }
    @objc private func showControls() -> Bool { revealControls?(); return true }
    func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
        (a is UILongPressGestureRecognizer && b is UIPanGestureRecognizer) || (b is UILongPressGestureRecognizer && a is UIPanGestureRecognizer)
    }
    func insertText(_ text: String) {
        if text == "\n" { key("Enter") } else if text == "\t" { key("Tab") }
        else { session?.input(["type": "text", "text": text]) }
    }
    func deleteBackward() { key("Backspace") }
    private func key(_ name: String, modifiers: Int = 0) { session?.input(["type": "key", "key": name, "modifiers": modifiers]) }
    @objc private func tabKey() { key("Tab") }
    @objc private func leftKey() { key("ArrowLeft") }
    @objc private func rightKey() { key("ArrowRight") }
    @objc private func hideKeyboard() { session?.keyboardVisible = false; resignFirstResponder() }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow, UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow, UIKeyCommand.inputEscape, "\t"].flatMap { input in
            [UIKeyCommand(input: input, modifierFlags: [], action: #selector(hardwareKey(_:))), UIKeyCommand(input: input, modifierFlags: .shift, action: #selector(hardwareKey(_:)))]
        }
    }
    @objc private func hardwareKey(_ command: UIKeyCommand) {
        let names = [UIKeyCommand.inputLeftArrow: "ArrowLeft", UIKeyCommand.inputRightArrow: "ArrowRight", UIKeyCommand.inputUpArrow: "ArrowUp", UIKeyCommand.inputDownArrow: "ArrowDown", UIKeyCommand.inputEscape: "Escape", "\t": "Tab"]
        if let input = command.input, let name = names[input] { key(name, modifiers: command.modifierFlags.contains(.shift) ? 8 : 0) }
    }
}
