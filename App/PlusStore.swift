import Foundation
import StoreKit

/// Hygge Plus, held the way StoreKit intends: the device reads
/// verified entitlements locally (that is the truth the UI and
/// the plan gates use), and each verified transaction is also
/// reported to the backend so scheduled work and the custom
/// email name agree with the phone. No product, no crash — the
/// sheet just keeps its buttons honest about being unavailable.
@MainActor
@Observable
final class PlusStore {
    private(set) var product: Product?
    private(set) var isPlus = false
    private(set) var expiresAt: Date?
    private(set) var purchaseInFlight = false
    private(set) var purchasePending = false
    private(set) var lastPurchaseFailed = false

    /// Installed by AppStore: ship one verified transaction's
    /// signed form to the backend.
    @ObservationIgnored var reportTransaction: ((String) async -> Void)?
    @ObservationIgnored private var updatesTask: Task<Void, Never>?
    @ObservationIgnored private var started = false

    var priceDisplay: String { product?.displayPrice ?? "$9.99" }

    func start() {
        guard !started else { return }
        started = true
        updatesTask = Task { [weak self] in
            for await update in Transaction.updates {
                await self?.apply(update)
            }
        }
        Task { [weak self] in
            await self?.loadProduct()
            await self?.refreshEntitlements()
        }
    }

    func loadProduct() async {
        if let found = try? await Product.products(for: [Plan.plusProductID]).first {
            product = found
        }
    }

    /// Read what the App Store currently grants this user.
    func refreshEntitlements() async {
        var plus = false
        var expiry: Date?
        var latestJWS: String?
        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement,
                  transaction.productID == Plan.plusProductID,
                  transaction.revocationDate == nil else { continue }
            if let expires = transaction.expirationDate, expires > Date() {
                plus = true
                expiry = expires
                latestJWS = entitlement.jwsRepresentation
            }
        }
        isPlus = plus
        expiresAt = expiry
        if let latestJWS { await reportTransaction?(latestJWS) }
    }

    private func apply(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result,
              transaction.productID == Plan.plusProductID else { return }
        await transaction.finish()
        await refreshEntitlements()
    }

    /// One tap: the system sheet does the asking. Returns true
    /// only when Plus is actually on afterwards.
    @discardableResult
    func purchase() async -> Bool {
        lastPurchaseFailed = false
        purchasePending = false
        if product == nil { await loadProduct() }
        guard let product else { lastPurchaseFailed = true; return false }
        purchaseInFlight = true
        defer { purchaseInFlight = false }
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                await apply(verification)
                return isPlus
            case .pending:
                purchasePending = true
                return false
            case .userCancelled:
                return false
            @unknown default:
                return false
            }
        } catch {
            lastPurchaseFailed = true
            return false
        }
    }

    @discardableResult
    func restore() async -> Bool {
        try? await StoreKit.AppStore.sync()
        await refreshEntitlements()
        return isPlus
    }
}
