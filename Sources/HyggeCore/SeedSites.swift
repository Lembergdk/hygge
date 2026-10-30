import Foundation

/// Starter list only. The cloud browser can be pointed at ANY site the user
/// adds; these seeds just give sensible first goals per category.
public enum SeedSites {
    public static let all: [TargetSite] = [
        site("rover", "Rover", "https://www.rover.com", .petCare,
             "Find dog-sitting and dog-walking requests near me and extract dates, pay and links."),
        site("trustedhousesitters", "TrustedHousesitters", "https://www.trustedhousesitters.com", .petCare,
             "Find house/pet sits matching my dates and extract location, dates, pets and links."),
        site("pawshake", "Pawshake", "https://www.pawshake.com", .petCare,
             "Find pet-sitting requests near me and extract dates, pay and links."),
        site("upwork", "Upwork", "https://www.upwork.com/nx/search/jobs/", .freelance,
             "Search jobs matching my skills, filter to my rate floor, extract title, budget and links."),
        site("fiverr", "Fiverr", "https://www.fiverr.com", .freelance,
             "Find buyer demand in my skill categories and draft gig listings from my profile."),
        site("contra", "Contra", "https://contra.com", .freelance,
             "Find freelance projects matching my skills and extract title, budget and links."),
        site("taskrabbit", "Taskrabbit", "https://www.taskrabbit.com", .localGig,
             "Survey task categories and going rates near me for my skills."),
        site("airtasker", "Airtasker", "https://www.airtasker.com/tasks", .localGig,
             "Find open tasks near me matching my skills; extract title, budget and links."),
        site("thumbtack", "Thumbtack", "https://www.thumbtack.com", .homeServices,
             "Find home-service leads near me matching my skills; extract title, budget and links."),
        site("reddit-forhire", "Reddit r/forhire", "https://www.reddit.com/r/forhire/", .community,
             "Find [Hiring] posts matching my skills; extract title, pay hints and links."),
        site("facebook-groups", "Facebook Groups", "https://www.facebook.com/groups/feed/", .community,
             "In my local groups, find posts asking for help matching my skills; extract text and links."),
        site("nextdoor", "Nextdoor", "https://www.nextdoor.com/news_feed/", .community,
             "Find neighbour posts asking for help matching my skills; extract text and links."),
        site("craigslist-gigs", "Craigslist gigs", "https://craigslist.org", .localGig,
             "Find gigs in my city matching my skills; extract title, pay hints and links."),
        site("indeed", "Indeed", "https://www.indeed.com/jobs", .remoteJob,
             "Search part-time/remote jobs matching my skills at or above my rate floor."),
        site("linkedin-jobs", "LinkedIn Jobs", "https://www.linkedin.com/jobs", .remoteJob,
             "Search contract/part-time roles matching my skills; extract title, company and links."),
        site("carecom", "Care.com", "https://www.care.com", .tutoring,
             "Find tutoring/care jobs near me matching my skills; extract title, pay and links."),
        site("doordash-drive", "DoorDash (drive)", "https://dasher.doordash.com", .delivery,
             "Walk through driver signup requirements and summarise what documents are needed.")
    ]

    private static func site(_ id: String, _ name: String, _ url: String,
                             _ category: OpportunityCategory, _ goal: String) -> TargetSite {
        TargetSite(id: id, name: name, startURLString: url, category: category, goalTemplate: goal)
    }

    public static func site(id: String) -> TargetSite? { all.first { $0.id == id } }

    public static func sites(for category: OpportunityCategory) -> [TargetSite] {
        all.filter { $0.category == category }
    }
}
