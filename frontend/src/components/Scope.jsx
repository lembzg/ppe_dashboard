import { useLayoutEffect, useRef, useState } from 'react';
import { CaretIcon, CheckIcon } from './icons.jsx';

// Organisation / site / zone breadcrumb menus. The open menu is held by the
// dashboard so Escape and outside clicks can close it.
export default function Scope({ data, openMenu, setOpenMenu }) {
  const [organisationId, setOrganisationId] = useState(data.organisations[0].id);
  const [siteId, setSiteId] = useState(data.currentSiteId);
  const [zoneName, setZoneName] = useState(null); // null means All zones
  const containerRef = useRef(null);

  useLayoutEffect(() => {
    if (!openMenu) return;
    const menu = containerRef.current.querySelector('.menu');
    const selected = menu.querySelector('[aria-checked="true"]') || menu.querySelector('.menu-item');
    if (selected) selected.focus();
  }, [openMenu]);

  const organisation = data.organisations.find((item) => item.id === organisationId);
  const site = data.sites.find((item) => item.id === siteId);
  const menus = [
    {
      key: 'organisation',
      label: organisation.name,
      options: data.organisations.map((item) => ({ value: item.id, label: item.name, selected: item.id === organisationId })),
      select: setOrganisationId,
    },
    {
      key: 'site',
      label: site.name,
      options: data.sites.map((item) => ({ value: item.id, label: item.name, selected: item.id === siteId })),
      select: setSiteId,
    },
    {
      key: 'zone',
      label: zoneName || 'All zones',
      options: [{ value: '', label: 'All zones', selected: !zoneName }].concat(
        data.zones.map((zone) => ({ value: zone.name, label: zone.name, selected: zone.name === zoneName }))),
      select: (value) => setZoneName(value || null),
    },
  ];

  function focusTrigger(menuKey) {
    containerRef.current.querySelector('[data-menu-trigger="' + menuKey + '"]').focus();
  }

  return (
    <nav className="scope" aria-label="Scope" ref={containerRef}>
      {menus.map((menu, index) => {
        const isOpen = openMenu === menu.key;
        return [
          index > 0 && <span key={menu.key + '-separator'} className="scope-separator" aria-hidden="true">/</span>,
          <div key={menu.key} className={'scope-segment scope-segment-' + menu.key}>
            <button
              type="button"
              className="scope-trigger"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              data-menu-trigger={menu.key}
              onClick={() => {
                setOpenMenu(isOpen ? null : menu.key);
                if (isOpen) focusTrigger(menu.key);
              }}
            >
              <span>{menu.label}</span><CaretIcon />
            </button>
            {isOpen && (
              <div className="menu" role="menu" aria-label={menu.key}>
                {menu.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="menu-item"
                    role="menuitemradio"
                    aria-checked={option.selected}
                    onClick={() => {
                      menu.select(option.value);
                      setOpenMenu(null);
                      focusTrigger(menu.key);
                    }}
                  >
                    <span>{option.label}</span>{option.selected && <CheckIcon />}
                  </button>
                ))}
              </div>
            )}
          </div>,
        ];
      })}
    </nav>
  );
}
