import AVFoundation
import CraniumKit
import UIKit

/// Scan board (bridge.json `camera.scan`; docs/mobile-apps.md "Scan board"): the camera full screen until
/// it reads one QR code, with AVFoundation's own QR reader and nothing else. The camera is asked for and
/// started only here, when the person taps Scan board, and stopped as soon as a code is read or the person
/// closes it. What the code says is checked by `BoardLink` before the page hears of it.
@MainActor
enum BoardScanner {
    /// Whether this iPhone has a camera to scan with (app.hello's `camera`).
    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    /// The thing name of the board whose code was read, or the bridge's refusal.
    static func scan(console: URL) async throws -> String {
        guard hasCamera else { throw BridgeError(.unavailable, "This iPhone has no camera.") }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                throw BridgeError(.unavailable, "The camera is not allowed for Cranium. Allow it in Settings to scan a board.")
            }
        default:
            throw BridgeError(.unavailable, "The camera is not allowed for Cranium. Allow it in Settings to scan a board.")
        }
        guard let top = UIApplication.shared.topViewController else { throw BridgeError.failed("The camera could not be shown.") }
        let text: String? = await withCheckedContinuation { continuation in
            let scanner = ScannerViewController { continuation.resume(returning: $0) }
            scanner.modalPresentationStyle = .fullScreen
            top.present(scanner, animated: true)
        }
        guard let text else { throw BridgeError(.cancelled, "The scan was closed.") }
        switch BoardLink.thing(in: text, console: console) {
        case .success(let thing): return thing
        case .failure(let refusal): throw BridgeError(.notAllowed, refusal.message)
        }
    }
}

/// The camera's picture with a Cancel button; hands back the first QR code it reads, or nil when closed.
private final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private var finish: ((String?) -> Void)?

    init(finish: @escaping (String?) -> Void) {
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            done(nil)
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            done(nil)
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)

        let hint = UILabel()
        hint.text = "Point the camera at the board’s label."
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .headline)
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancel.tintColor = .white
        cancel.accessibilityIdentifier = "scan-cancel"
        cancel.addAction(UIAction { [weak self] _ in self?.done(nil) }, for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            hint.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            hint.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            hint.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.bounds }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
    }

    /// Called on the main queue (setMetadataObjectsDelegate above).
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        let text = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
        guard let text else { return }
        done(text)
    }

    /// Once: the camera stops, the screen goes, and the answer is handed back.
    private func done(_ text: String?) {
        guard let finish else { return }
        self.finish = nil
        session.stopRunning()
        if presentingViewController != nil {
            dismiss(animated: true) { finish(text) }
        } else {
            finish(text)
        }
    }
}
