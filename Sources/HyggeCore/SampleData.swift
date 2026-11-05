import Foundation

/// Demo listings so the feed, matching, and approval flow work before any live
/// source is connected. Every demo item is flagged `isDemo` and labelled in the UI.
public enum SampleData {
    public static let opportunities: [Opportunity] = [
        .init(siteID: "rover", title: "Weekend dog sitting for a gentle labrador",
              summary: "Two nights of boarding, daily walks, feeding. Owner provides food and lead.",
              category: .petCare, payLabel: "$45/night", estimatedHourly: 30,
              locationLabel: "Your neighbourhood", isRemote: false,
              requiredSkills: ["Pet sitting", "Dog walking"],
              urlString: "https://www.rover.com", isDemo: true),
        .init(siteID: "trustedhousesitters", title: "House + cat sit, 2 weeks",
              summary: "Water plants, feed an indoor cat twice a day, collect mail.",
              category: .petCare, payLabel: "Stay exchange", estimatedHourly: nil,
              locationLabel: "Suburbs", isRemote: false,
              requiredSkills: ["House sitting", "Cat care"],
              urlString: "https://www.trustedhousesitters.com", isDemo: true),

        .init(siteID: "taskrabbit", title: "Assemble a bookshelf and desk",
              summary: "Flat-pack assembly, tools provided, about 2 hours.",
              category: .localGig, payLabel: "$38/hr", estimatedHourly: 38,
              locationLabel: "City centre", isRemote: false,
              requiredSkills: ["Furniture assembly"],
              urlString: "https://www.taskrabbit.com", isDemo: true),
        .init(siteID: "airtasker", title: "End-of-lease clean, 2-bed flat",
              summary: "Kitchen, bathroom, oven, windows inside. Supplies provided.",
              category: .homeServices, payLabel: "$180 total", estimatedHourly: 36,
              locationLabel: "North side", isRemote: false,
              requiredSkills: ["Cleaning"],
              urlString: "https://www.airtasker.com", isDemo: true),
        .init(siteID: "airtasker", title: "Garden tidy + hedge trim",
              summary: "Half-day garden tidy for an elderly homeowner. Green waste removal included.",
              category: .homeServices, payLabel: "$35/hr", estimatedHourly: 35,
              locationLabel: "West side", isRemote: false,
              requiredSkills: ["Gardening"],
              urlString: "https://www.airtasker.com", isDemo: true),
        .init(siteID: "indeed", title: "Part-time remote bookkeeper (10 hrs/week)",
              summary: "Small e-commerce shop. Xero reconciliations and payroll support.",
              category: .remoteJob, payLabel: "$28/hr", estimatedHourly: 28,
              locationLabel: "Remote", isRemote: true,
              requiredSkills: ["Bookkeeping"],
              urlString: "https://www.indeed.com", isDemo: true),
        .init(siteID: "fiverr", title: "Buyer request: logo refresh for a dog-grooming salon",
              summary: "Modernise an existing logo, deliver SVG + PNG + brand colours.",
              category: .creative, payLabel: "$150 fixed", estimatedHourly: 50,
              locationLabel: "Remote", isRemote: true,
              requiredSkills: ["Graphic design"],
              urlString: "https://www.fiverr.com", isDemo: true)
    ]
}
