# frozen_string_literal: true

describe "Custom sidebar sections", type: :system do
  fab!(:user) { Fabricate(:user) }
  fab!(:admin) { Fabricate(:admin) }
  let(:section_modal) { PageObjects::Modals::SidebarSectionForm.new }
  let(:sidebar) { PageObjects::Components::Sidebar.new }

  it "allows the user to create custom section" do
    visit("/latest")

    expect(sidebar).to have_no_add_section_button

    sign_in user
    visit("/latest")
    sidebar.click_add_section_button

    expect(section_modal).to be_visible
    expect(section_modal).to have_disabled_save
    expect(sidebar.custom_section_modal_title).to have_content("Add custom section")

    section_modal.fill_name("My section")

    section_modal.fill_link("Sidebar Tags", "/tags")
    expect(section_modal).to have_enabled_save

    section_modal.save

    expect(sidebar).to have_section("My section")
    expect(sidebar).to have_section_link("Sidebar Tags")
  end

  it "allows the user to create custom section with /my link" do
    sign_in user
    visit("/latest")

    sidebar.click_add_section_button
    section_modal.fill_name("My section")
    section_modal.fill_link("My preferences", "/my/preferences")
    section_modal.save

    expect(sidebar).to have_section("My section")
    expect(sidebar).to have_section_link("My preferences")
  end

  it "allows the user to create custom section with /pub link" do
    sign_in user
    visit("/latest")

    sidebar.click_add_section_button
    section_modal.fill_name("My section")
    section_modal.fill_link("Published Page", "/pub/test")
    section_modal.save

    expect(sidebar).to have_section("My section")
    expect(sidebar).to have_section_link("Published Page")
  end

  it "allows the user to create custom section with external link" do
    sign_in user
    visit("/latest")
    sidebar.click_add_section_button

    expect(section_modal).to be_visible
    expect(section_modal).to have_disabled_save
    expect(sidebar.custom_section_modal_title).to have_content("Add custom section")

    section_modal.fill_name("My section")

    section_modal.fill_link("Discourse Homepage", "htt")
    expect(section_modal).to have_disabled_save

    section_modal.fill_link("Discourse Homepage", "https://discourse.org")
    expect(section_modal).to have_enabled_save

    section_modal.save

    expect(sidebar).to have_section("My section")
    expect(sidebar).to have_section_link("Discourse Homepage", href: "https://discourse.org")
  end

  it "allows the user to edit custom section" do
    sidebar_section = Fabricate(:sidebar_section, title: "My section", user: user)
    sidebar_url_1 = Fabricate(:sidebar_url, name: "Sidebar Tags", value: "/tags")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_1)
    sidebar_url_2 = Fabricate(:sidebar_url, name: "Sidebar Categories", value: "/categories")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_2)

    sign_in user
    visit("/latest")

    sidebar.edit_custom_section("My section")
    expect(find("#discourse-modal-title")).to have_content("Edit custom section")

    section_modal.fill_name("Edited section")
    section_modal.fill_link("Edited Tags", "/tags")
    section_modal.remove_last_link

    section_modal.save

    expect(sidebar).to have_section("Edited section")
    expect(sidebar).to have_section_link("Edited Tag")

    expect(sidebar).to have_no_section_link("Sidebar Categories")
  end

  it "allows the user to reorder links in custom section" do
    sidebar_section = Fabricate(:sidebar_section, title: "My section", user: user)
    sidebar_url_1 = Fabricate(:sidebar_url, name: "Sidebar Tags", value: "/tags")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_1)
    sidebar_url_2 = Fabricate(:sidebar_url, name: "Sidebar Categories", value: "/categories")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_2)

    sign_in user
    visit("/latest")

    expect(sidebar.primary_section_links("my-section")).to eq(
      ["Sidebar Tags", "Sidebar Categories"],
    )

    tags_link = find(".sidebar-section-link[data-link-name='Sidebar Tags']")
    categories_link = find(".sidebar-section-link[data-link-name='Sidebar Categories']")
    tags_link.drag_to(categories_link, html5: true, delay: 0.4)

    expect(sidebar.primary_section_links("my-section")).to eq(
      ["Sidebar Categories", "Sidebar Tags"],
    )
  end

  it "does not allow the user to edit public section" do
    sidebar_section = Fabricate(:sidebar_section, title: "Public section", public: true)
    sidebar_url_1 = Fabricate(:sidebar_url, name: "Sidebar Tags", value: "/tags")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_1)
    sidebar_url_2 = Fabricate(:sidebar_url, name: "Sidebar Categories", value: "/categories")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_2)

    sign_in user
    visit("/latest")

    expect(sidebar).to have_section("Public section")

    find(".sidebar-section[data-section-name='public-section']").hover

    expect(page).not_to have_css(
      ".sidebar-section[data-section-name='public-section'] button.sidebar-section-header-button",
    )

    expect(page).not_to have_css(
      ".sidebar-section[data-section-name='public-section'] .d-icon-globe",
    )
  end

  it "allows the user to delete custom section" do
    sidebar_section = Fabricate(:sidebar_section, title: "My section", user: user)
    sidebar_url_1 = Fabricate(:sidebar_url, name: "tags", value: "/tags")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_1)

    sign_in user
    visit("/latest")

    sidebar.edit_custom_section("My section")

    section_modal.delete
    section_modal.confirm_delete

    expect(sidebar).to have_no_section("My section")
  end

  it "allows admin to create, edit and delete public section" do
    sign_in admin
    visit("/latest")
    sidebar.click_add_section_button

    section_modal.fill_name("Public section")
    section_modal.fill_link("Sidebar Tags", "/tags")
    section_modal.mark_as_public
    section_modal.save

    expect(sidebar).to have_section("Public section")
    expect(sidebar).to have_section_link("Sidebar Tags")
    expect(page).to have_css(".sidebar-section[data-section-name='public-section'] .d-icon-globe")

    sidebar.edit_custom_section("Public section")
    section_modal.fill_name("Edited public section")
    section_modal.save

    expect(sidebar).to have_section("Edited public section")

    sidebar.edit_custom_section("Edited public section")
    section_modal.delete
    section_modal.confirm_delete

    expect(sidebar).to have_no_section("Edited public section")
  end

  it "allows admin to edit community section and reset to default" do
    sign_in admin
    visit("/latest")

    expect(sidebar.primary_section_icons("community")).to eq(
      %w[layer-group user flag wrench ellipsis-v],
    )

    sidebar.edit_custom_section("Community")
    section_modal.fill_link("Everything", "/latest", "paper-plane")
    section_modal.fill_name("Edited community section")
    section_modal.everything_link.drag_to(section_modal.review_link, delay: 0.4)
    section_modal.save

    expect(sidebar).to have_section("Edited community section")
    expect(sidebar.primary_section_links("edited-community-section")).to eq(
      ["My Posts", "Everything", "Review", "Admin", "More"],
    )
    expect(sidebar.primary_section_icons("edited-community-section")).to eq(
      %w[user paper-plane flag wrench ellipsis-v],
    )

    sidebar.edit_custom_section("Edited community section")
    section_modal.reset

    expect(sidebar).to have_section("Community")
    expect(sidebar.primary_section_links("community")).to eq(
      ["Everything", "My Posts", "Review", "Admin", "More"],
    )
    expect(sidebar.primary_section_icons("community")).to eq(
      %w[layer-group user flag wrench ellipsis-v],
    )
  end

  it "shows anonymous public sections" do
    sidebar_section = Fabricate(:sidebar_section, title: "Public section", public: true)
    sidebar_url_1 = Fabricate(:sidebar_url, name: "Sidebar Tags", value: "/tags")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_1)
    sidebar_url_2 = Fabricate(:sidebar_url, name: "Sidebar Categories", value: "/categories")
    Fabricate(:sidebar_section_link, sidebar_section: sidebar_section, linkable: sidebar_url_2)

    visit("/latest")
    expect(sidebar).to have_section("Public section")
    expect(sidebar).to have_section_link("Sidebar Tags")
    expect(sidebar).to have_section_link("Sidebar Categories")
  end

  it "validates custom section fields" do
    sign_in user
    visit("/latest")
    sidebar.click_add_section_button

    section_modal.fill_name("A" * (SidebarSection::MAX_TITLE_LENGTH + 1))
    section_modal.fill_link("B" * (SidebarUrl::MAX_NAME_LENGTH + 1), "/wrong-url")

    expect(page.find(".title.warning")).to have_content("Title must be shorter than 30 characters")
    expect(page.find(".name.warning")).to have_content("Name must be shorter than 80 characters")
    expect(page.find(".value.warning")).to have_content("Format is invalid")

    section_modal.fill_name("")
    section_modal.fill_link("", "")
    expect(page.find(".title.warning")).to have_content("Title cannot be blank")
    expect(page.find(".name.warning")).to have_content("Name cannot be blank")
    expect(page.find(".value.warning")).to have_content("Link cannot be blank")

    expect(section_modal).to have_disabled_save
  end
end
